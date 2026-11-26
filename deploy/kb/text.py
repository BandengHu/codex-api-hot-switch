"""中文分块与分词。

SQLite FTS5 对中文不友好：
- unicode61 把整段中文当一个 token（实测 2 字词检索 0 命中）
- trigram 只支持 >=3 字符（实测「安全」「5G」全部 miss）

因此这里用 jieba 预先把中文切成空格分隔的词元喂给 unicode61，
检索时同样切词，再拼成 FTS5 的 AND 查询。
"""

import re
from typing import Iterable, List

import jieba

from config import CHUNK_OVERLAP_CHARS, CHUNK_TARGET_CHARS

# 标点、空白、全角符号：分词前不作为语义内容
_PUNCT_RE = re.compile(r"[\s\u3000-\u303f\uff00-\uffef!-/:-@\[-`{-~]+")
# 句末停顿，用于按句切分
_SENT_SPLIT_RE = re.compile(r"(?<=[\u3002\uff01\uff1f\uff1b])")
# FTS5 语法中的保留符，出现在 token 里会导致 MATCH 报错
_FTS_UNSAFE_RE = re.compile(r'["*():^\-]')


def segment(text: str) -> List[str]:
    """把中文文本切成检索词元，保留英文/数字原样，丢弃纯标点。"""
    if not text:
        return []
    cleaned = _PUNCT_RE.sub(" ", text)
    tokens: List[str] = []
    for raw in jieba.cut_for_search(cleaned):
        token = raw.strip()
        if not token:
            continue
        token = _FTS_UNSAFE_RE.sub("", token)
        if not token:
            continue
        tokens.append(token)
    return tokens


def segment_text(text: str) -> str:
    """分词后以空格拼接，写入 FTS5 的索引列。"""
    return " ".join(_dedupe_keep_order(segment(text)))


def _dedupe_keep_order(items: Iterable[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def build_match_query(query: str, mode: str = "and") -> str:
    """把用户查询转成 FTS5 MATCH 表达式。

    and 模式：所有词元都要出现（精确优先）
    or  模式：任一出现即可（召回优先，用于补充候选）
    """
    tokens = _dedupe_keep_order(segment(query))
    if not tokens:
        return ""
    quoted = ['"%s"' % token.replace('"', "") for token in tokens]
    joiner = " AND " if mode == "and" else " OR "
    return joiner.join(quoted)


def split_sentences(text: str) -> List[str]:
    if not text:
        return []
    parts = [chunk.strip() for chunk in _SENT_SPLIT_RE.split(text)]
    return [part for part in parts if part]


def chunk_text(
    text: str,
    target: int = None,
    overlap: int = None,
) -> List[str]:
    """按句子边界把长文本切成带重叠的分块，尽量不切断语义。"""
    target = target or CHUNK_TARGET_CHARS
    overlap = overlap or CHUNK_OVERLAP_CHARS
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= target:
        return [text]

    sentences = split_sentences(text) or [text]
    chunks: List[str] = []
    current: List[str] = []
    current_len = 0

    for sentence in sentences:
        # 单句超长时按字符硬切，避免一个分块远超目标长度
        while len(sentence) > target:
            head, sentence = sentence[:target], sentence[target:]
            if current:
                chunks.append("".join(current))
                current, current_len = [], 0
            chunks.append(head)

        if current_len + len(sentence) > target and current:
            chunks.append("".join(current))
            tail = "".join(current)[-overlap:] if overlap > 0 else ""
            current = [tail] if tail else []
            current_len = len(tail)

        current.append(sentence)
        current_len += len(sentence)

    if current:
        chunks.append("".join(current))

    return [chunk.strip() for chunk in chunks if chunk.strip()]

