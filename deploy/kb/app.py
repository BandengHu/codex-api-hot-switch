"""知识库 HTTP 服务：给智能体用的检索 API + 自带检索页。

架构：向量在本地算好，服务器只做存储和查询，不加载任何模型。
- 只监听 127.0.0.1，由外层 TLS 反代暴露到 443
- 无鉴权：检索页与接口均可直接访问
- 一个服务承载多个知识库，新增题库 = 上传一份新索引，互不影响
"""

import logging
import time
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import AliasChoices, BaseModel, Field

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


class SearchRequest(BaseModel):
    # q 和 query 都接受：调用方有的按 GET 习惯写 q，有的按语义写 query，
    # 只认其中一个会让另一种写法静默变成空查询（返回「query 不能为空」）。
    query: str = Field(
        default="",
        validation_alias=AliasChoices("query", "q"),
        description="检索问题（也接受 q）",
    )
    library: str = Field(default="", description="库名，留空则查全部库")
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
def agent_card():
    card = build_agent_card()
    card["libraries"] = [
        {"name": lib["name"], "title": lib["title"], "documents": lib["doc_count"],
         "chunks": lib["chunk_count"], "chars": lib["char_count"], "dim": lib["dim"]}
        for lib in index.list_libraries()
    ]
    return card


@app.get("/v1/libraries")
def list_libraries():
    libs = index.list_libraries()
    return {"libraries": libs, "count": len(libs)}


@app.post("/v1/search")
def search_post(payload: SearchRequest):
    return _do_search(payload)


@app.get("/v1/search")
def search_get(
    q: Optional[str] = Query(default=None, description="检索问题"),
    query: Optional[str] = Query(default=None, description="检索问题的别名，等同 q"),
    library: str = Query(default=""),
    mode: str = Query(default="hybrid"),
    top_k: int = Query(default=config.DEFAULT_TOP_K, ge=1, le=50),
    regex: Optional[str] = Query(default=None),
):
    # 和 POST 一致：query 优先，其次 q
    text = (query if query is not None else q) or ""
    return _do_search(SearchRequest(query=text, library=library, mode=mode,
                                    top_k=top_k, regex=regex))


def _do_search(payload: SearchRequest) -> dict:
    libraries = _resolve_libraries(payload.library)
    if not libraries:
        raise HTTPException(status_code=404, detail="知识库为空")
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
    merged = fuse_libraries(results, payload.top_k)
    return {"mode": payload.mode, "query": payload.query, "libraries": libraries,
            "hits": merged, "count": len(merged)}


def fuse_libraries(results: List[dict], top_k: int, k: int = 60) -> List[dict]:
    """跨库融合：只用各库内部的排名做 RRF，不比较原始分数。

    不同模式的分数尺度完全不可比：bm25 越小越好、向量相似度越大越好、
    正则全扫描根本没有分数。按分数字段排序会让它们互相湮没，最终退化成
    「按库的遍历顺序拼接」，新增第二个库后第一名会变成先遍历到的那个库。
    因此这里只看 hits[].rank，用 RRF 合并。
    """
    fused: dict = {}
    for item in results:
        library = item["library"]
        for hit in item["hits"]:
            if "id" not in hit:  # 正则的报错条目没有分块 id，直接透传
                continue
            chunk_id = hit["id"]
            entry = fused.get(chunk_id)
            if entry is None:
                entry = dict(hit)
                entry["rrf"] = 0.0
                entry["libraries"] = []
                fused[chunk_id] = entry
            if library not in entry["libraries"]:
                entry["libraries"].append(library)
            rank = hit.get("rank") or top_k
            entry["rrf"] += 1.0 / (k + rank)

    ordered = sorted(fused.values(), key=lambda row: -row["rrf"])
    out = []
    for rank, entry in enumerate(ordered[:top_k], start=1):
        item = dict(entry)
        item["rank"] = rank
        item["library"] = item["libraries"][0]
        out.append(item)
    return out


class EmbedRequest(BaseModel):
    text: str = Field(description="要编码的文本")
    is_query: bool = Field(default=True, description="True 加检索指令前缀，False 按文档编码")


@app.post("/v1/embed")
def embed(payload: EmbedRequest):
    try:
        from embedder import get_embedder
    except Exception as exc:
        raise HTTPException(status_code=503, detail="编码器不可用: %s" % exc) from exc
    vector = get_embedder().encode_one(payload.text, payload.is_query)
    return {"dim": len(vector), "vector": vector}


def _resolve_libraries(requested: str) -> List[str]:
    if requested:
        if not index.library_exists(requested):
            raise HTTPException(status_code=404, detail="知识库不存在: %s" % requested)
        return [requested]
    return [lib["name"] for lib in index.list_libraries()]


@app.get("/v1/documents/{document_id}")
def get_document(document_id: int):
    doc = index.get_document(document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="文档不存在")
    doc["chunks"] = index.get_document_chunks(document_id)
    return doc


@app.post("/v1/reload")
def reload_index():
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

