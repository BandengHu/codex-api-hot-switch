"""给智能体看的接入说明：直接拼成一段可复制的 prompt 片段。"""

import config


def build_agent_card() -> dict:
    base = config.PUBLIC_BASE_URL.rstrip("/")
    if not base:
        base = "https://huhuanjie.site/kb"
    return {
        "name": "Knowledge Base",
        "description": "中文课程/题库知识库检索服务，支持全文检索、正则匹配、向量语义搜索与混合排序",
        "base_url": base,
        "auth": {"type": "none", "desc": "无需鉴权，直接请求即可"},
        "endpoints": [
            {
                "method": "GET",
                "path": "/v1/libraries",
                "desc": "列出可访问的知识库及文档数",
            },
            {
                "method": "GET",
                "path": "/v1/search?q=北斗和5G怎么融合&library=lianTongPartySchool&mode=hybrid&top_k=8",
                "desc": "最快接入方式：URL 直传查询，返回命中的分块",
            },
            {
                "method": "POST",
                "path": "/v1/search",
                "desc": "结构化检索，body 见下",
                "body": {
                    "query": "北斗和5G怎么融合",
                    "library": "lianTongPartySchool",
                    "mode": "hybrid",
                    "top_k": 8,
                    "regex": None,
                    "document_id": None,
                },
            },
            {
                "method": "GET",
                "path": "/v1/documents/{document_id}",
                "desc": "取整篇文档（含全部分块），用于展开上下文",
            },
        ],
        "modes": {
            "hybrid": "全文 + 向量 RRF 融合，日常首选",
            "keyword": "FTS5 精确匹配，适合查专有名词、编号",
            "semantic": "向量语义，适合换个说法提问",
            "regex": "正则，适合查固定格式（如 '5G.*切片'）",
        },
        "notes": [
            "hits[].content 是命中的分块正文，hits[].heading 是它出自哪一节",
            "hits[].document_id 可再调 /v1/documents/{id} 拿全文",
            "文档量大的库先用 keyword 或 hybrid，不要直接拉全文",
        ],
    }

