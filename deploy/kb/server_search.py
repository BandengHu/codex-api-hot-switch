"""服务器端检索：只读索引，不加载模型、不做编码。

向量在本地算好（build_index.py），服务器上只负责：
- FTS5 关键词 / 正则
- 已算好的向量做余弦相似度
- 三路 RRF 融合

因此进程常驻内存很小，也不需要 onnxruntime。
"""

import logging
import re
import time
from typing import Dict, List, Optional

import numpy as np

from text import build_match_query

log = logging.getLogger("kb.search")


def search(
    index,
    library: str,
    query: str = "",
    query_vector: Optional[List[float]] = None,
    mode: str = "hybrid",
    top_k: int = 8,
    regex: Optional[str] = None,
    document_id: Optional[int] = None,
) -> Dict:
    started = time.time()
    query = (query or "").strip()
    mode = (mode or "hybrid").lower()

    if mode == "regex" or regex:
        pattern = regex or query
        hits = _regex_search(index, library, pattern, top_k, document_id)
        return {
            "mode": "regex",
            "query": query,
            "regex": pattern,
            "took_ms": int((time.time() - started) * 1000),
            "hits": hits,
            "count": len(hits),
        }

    if not query:
        return {"mode": mode, "query": "", "took_ms": 0, "hits": [], "count": 0,
                "error": "query 不能为空"}

    keyword_hits: List[Dict] = []
    semantic_hits: List[Dict] = []

    if mode in ("keyword", "hybrid"):
        keyword_hits = _keyword_search(index, library, query, top_k * 3, document_id)

    if mode in ("semantic", "hybrid"):
        if query_vector is None:
            # 没有现成向量时，用关键词结果兜底并把原因说清楚
            semantic_hits = []
        else:
            semantic_hits = _vector_search(index, library, query_vector, top_k * 3, document_id)

    if mode == "keyword":
        merged = _decorate(keyword_hits, "keyword")
    elif mode == "semantic":
        merged = _decorate(semantic_hits, "semantic")
    else:
        merged = _rrf_fuse(keyword_hits, semantic_hits)

    merged = merged[:top_k]
    payload = {
        "mode": mode,
        "query": query,
        "took_ms": int((time.time() - started) * 1000),
        "hits": merged,
        "count": len(merged),
    }
    if mode in ("semantic", "hybrid") and query_vector is None:
        payload["notice"] = "未传入 query_vector，语义路已跳过（可用 /v1/embed 或本地编码）"
    return payload


def _keyword_search(index, library: str, query: str, limit: int, document_id):
    expression = build_match_query(query, "and")
    rows = index.match_expression(expression, library, limit)
    if not rows:
        rows = index.match_expression(build_match_query(query, "or"), library, limit)
    if document_id is not None:
        rows = [row for row in rows if row["document_id"] == document_id]
    return rows


def _vector_search(index, library: str, vector, limit: int, document_id):
    rows = index.vector_search(vector, library, limit)
    if document_id is not None:
        rows = [row for row in rows if row["document_id"] == document_id]
    return rows


def _regex_search(index, library: str, pattern: str, limit: int, document_id):
    try:
        compiled = re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        return [{"error": "正则表达式无效: %s" % exc}]

    probe = _longest_literal(pattern)
    expression = build_match_query(probe, "and") if probe else ""
    rows = index.match_expression(expression, library, max(limit * 40, 400)) if expression else []
    if not rows:
        rows = index.scan_chunks(library, max(limit * 40, 400))
    if document_id is not None:
        rows = [row for row in rows if row["document_id"] == document_id]

    hits = []
    for row in rows:
        match = compiled.search(row["content"]) or compiled.search(row["title"] or "")
        if not match:
            continue
        item = dict(row)
        item["matched"] = match.group(0)
        item["match_span"] = list(match.span())
        item["rank"] = len(hits) + 1
        item["match_mode"] = "regex"
        hits.append(item)
        if len(hits) >= limit:
            break
    return hits


def _longest_literal(pattern: str) -> str:
    runs = re.findall(r"[\u4e00-\u9fff]{2,}", pattern)
    if runs:
        return max(runs, key=len)
    words = re.findall(r"[A-Za-z0-9_]{2,}", pattern)
    if words:
        return max(words, key=len)
    return ""


def _rrf_fuse(keyword_hits: List[Dict], semantic_hits: List[Dict], k: int = 60) -> List[Dict]:
    fused: Dict[int, Dict] = {}
    for rank, row in enumerate(keyword_hits, start=1):
        entry = fused.setdefault(row["id"], {**row, "sources": [], "rrf": 0.0})
        entry["sources"].append("keyword")
        entry["rrf"] += 1.0 / (k + rank)
        entry["keyword_rank"] = rank
        entry["keyword_score"] = row.get("score")

    for rank, row in enumerate(semantic_hits, start=1):
        entry = fused.setdefault(row["id"], {**row, "sources": [], "rrf": 0.0})
        entry["sources"].append("semantic")
        entry["rrf"] += 1.0 / (k + rank)
        entry["semantic_rank"] = rank
        entry["similarity"] = row.get("similarity")

    ordered = sorted(fused.values(), key=lambda item: -item["rrf"])
    return _decorate(ordered, "hybrid")


def _decorate(rows: List[Dict], mode: str) -> List[Dict]:
    out = []
    for rank, row in enumerate(rows, start=1):
        item = dict(row)
        item["rank"] = rank
        item["match_mode"] = mode
        content = item.get("content") or ""
        if len(content) > 500:
            item["content"] = content[:500] + "…"
        out.append(item)
    return out


def cosine_scores(matrix: np.ndarray, vector: np.ndarray) -> np.ndarray:
    """索引里存的都是归一化向量，点积即余弦相似度。"""
    return matrix @ vector

