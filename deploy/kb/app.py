"""知识库 HTTP 服务：给智能体用的检索 API + 自带检索页。

架构：向量在本地算好，服务器只做存储和查询，不加载任何模型。
- 只监听 127.0.0.1，由外层 TLS 反代暴露到 443
- API Key 走 x-api-key / Authorization: Bearer
- 一个服务承载多个知识库，新增题库 = 上传一份新索引，互不影响
"""

import logging
import time
from pathlib import Path
from typing import List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import auth
import config
from index_store import IndexStore
from openapi_hint import build_agent_card
from server_search import search as run_search

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("kb.app")

app = FastAPI(
    title="Knowledge Base Service",
    version="2.0.0",
    docs_url="/docs",
    root_path=config.PATH_PREFIX,
)
index = IndexStore(config.DB_PATH)


@app.on_event("startup")
def warmup():
    """预热分词器：jieba 首次加载约 600ms，不预热会让第一个查询很慢。"""
    started = time.time()
    from text import segment_text
    segment_text("预热分词器，避免首个请求触发词典加载")
    embed_ready = None
    try:
        from embedder import get_embedder
        embedder = get_embedder()
        embedder.encode_one("预热")
        embed_ready = round(embedder.load_seconds, 2)
    except Exception as exc:  # 模型缺失不应阻止关键词检索
        log.warning("embedder unavailable: %s", exc)
    log.info("warmup done in %.0f ms; embedder_load=%ss; vectors=%s",
             (time.time() - started) * 1000, embed_ready, index.vector_stats())


def extract_key(x_api_key: Optional[str] = Header(default=None, alias="x-api-key"),
                authorization: Optional[str] = Header(default=None)) -> str:
    if x_api_key:
        return x_api_key.strip()
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return ""


def require_key(request: Request) -> dict:
    raw = extract_key(request.headers.get("x-api-key"), request.headers.get("authorization"))
    record = auth.authenticate(raw)
    if record is None:
        log.warning("auth rejected fp=%s path=%s",
                    auth.fingerprint(raw) if raw else "absent", request.url.path)
        raise HTTPException(status_code=401, detail="无效的 API Key")
    return record


def require_library_access(record: dict, library: str) -> None:
    if not auth.can_access(record, library):
        raise HTTPException(status_code=403, detail="该 Key 无权访问知识库: %s" % library)


class SearchRequest(BaseModel):
    query: str = Field(default="", description="检索问题")
    library: str = Field(default="", description="库名，留空则查全部可访问库")
    mode: str = Field(default="hybrid", description="hybrid | keyword | semantic | regex")
    top_k: int = Field(default=config.DEFAULT_TOP_K, ge=1, le=50)
    regex: Optional[str] = Field(default=None, description="正则，传入则强制 regex")
    document_id: Optional[int] = Field(default=None, description="限定在某篇文档内")
    query_vector: Optional[List[float]] = Field(
        default=None,
        description="已算好的查询向量；不给则服务端自动编码",
    )
    auto_embed: bool = Field(default=True, description="允许服务端自动编码查询")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "libraries": len(index.list_libraries()),
        "vectors": index.vector_stats(),
    }


@app.get("/v1/agent-card")
def agent_card(record: dict = Depends(require_key)):
    card = build_agent_card()
    card["libraries"] = [
        {"name": lib["name"], "title": lib["title"], "documents": lib["doc_count"],
         "chunks": lib["chunk_count"], "chars": lib["char_count"], "dim": lib["dim"]}
        for lib in index.list_libraries() if auth.can_access(record, lib["name"])
    ]
    return card


@app.get("/v1/libraries")
def list_libraries(record: dict = Depends(require_key)):
    libs = [lib for lib in index.list_libraries() if auth.can_access(record, lib["name"])]
    return {"libraries": libs, "count": len(libs)}


@app.post("/v1/search")
def search_post(payload: SearchRequest, record: dict = Depends(require_key)):
    return _do_search(payload, record)


@app.get("/v1/search")
def search_get(
    q: str = Query(default="", description="检索问题"),
    library: str = Query(default=""),
    mode: str = Query(default="hybrid"),
    top_k: int = Query(default=config.DEFAULT_TOP_K, ge=1, le=50),
    regex: Optional[str] = Query(default=None),
    record: dict = Depends(require_key),
):
    return _do_search(SearchRequest(query=q, library=library, mode=mode,
                                    top_k=top_k, regex=regex), record)


def _do_search(payload: SearchRequest, record: dict) -> dict:
    libraries = _resolve_libraries(payload.library, record)
    if not libraries:
        raise HTTPException(status_code=404, detail="没有可访问的知识库")
    vector = payload.query_vector
    if vector is None and payload.auto_embed and payload.mode in ("semantic", "hybrid") and payload.query.strip():
        try:
            from embedder import get_embedder
            vector = get_embedder().encode_one(payload.query)
        except Exception as exc:
            log.warning("auto embed failed: %s", exc)
    results = []
    for library in libraries:
        data = run_search(
            index, library,
            query=payload.query,
            query_vector=vector,
            mode=payload.mode,
            top_k=payload.top_k,
            regex=payload.regex,
            document_id=payload.document_id,
        )
        data["library"] = library
        results.append(data)
    if len(results) == 1:
        return results[0]
    merged = sorted(
        [hit | {"library": item["library"]} for item in results for hit in item["hits"]],
        key=lambda hit: -hit.get("rrf", 0),
    )[: payload.top_k]
    return {"mode": payload.mode, "query": payload.query, "libraries": libraries,
            "hits": merged, "count": len(merged)}


class EmbedRequest(BaseModel):
    text: str = Field(description="要编码的文本")
    is_query: bool = Field(default=True, description="True 加检索指令前缀，False 按文档编码")


@app.post("/v1/embed")
def embed(payload: EmbedRequest, record: dict = Depends(require_key)):
    try:
        from embedder import get_embedder
    except Exception as exc:
        raise HTTPException(status_code=503, detail="编码器不可用: %s" % exc) from exc
    vector = get_embedder().encode_one(payload.text, payload.is_query)
    return {"dim": len(vector), "vector": vector}


def _resolve_libraries(requested: str, record: dict) -> List[str]:
    if requested:
        require_library_access(record, requested)
        if not index.library_exists(requested):
            raise HTTPException(status_code=404, detail="知识库不存在: %s" % requested)
        return [requested]
    return [lib["name"] for lib in index.list_libraries() if auth.can_access(record, lib["name"])]


@app.get("/v1/documents/{document_id}")
def get_document(document_id: int, record: dict = Depends(require_key)):
    doc = index.get_document(document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="文档不存在")
    require_library_access(record, doc["library"])
    doc["chunks"] = index.get_document_chunks(document_id)
    return doc


@app.post("/v1/reload")
def reload_index(record: dict = Depends(require_key)):
    """上传新索引后热加载向量，不用重启服务。"""
    return {"loaded": index.reload_vectors(), "libraries": [l["name"] for l in index.list_libraries()]}


@app.get("/", response_class=HTMLResponse)
def index_page():
    return HTMLResponse((Path(__file__).parent / "static" / "index.html").read_text(encoding="utf-8"))


static_dir = Path(__file__).parent / "static"
if static_dir.is_dir():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.exception_handler(HTTPException)
def http_error_handler(_request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code,
                        content={"error": exc.detail, "status": exc.status_code})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.LISTEN_HOST, port=config.LISTEN_PORT,
                log_level="info", access_log=False)

