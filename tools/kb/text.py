"""分块与中文分词：与服务器端保持同一套规则。"""

import re
from typing import Iterable, List

CHUNK_TARGET_CHARS = 420
CHUNK_OVERLAP_CHARS = 80

_PUNCT_RE = re.compile(r"[\s\u3000-\u303f\uff00-\uffef!-/:-@\[-`{-~]+")
_SENT_SPLIT_RE = re.compile(r"(?<=[\u3002\uff01\uff1f\uff1b])")
_FTS_UNSAFE_RE = re.compile(r'["*():^\-]')


def segment(text: str) -> List[str]:
    import jieba
    if not text:
        return []
    cleaned = _PUNCT_RE.sub(" ", text)
    tokens = []
    for raw in jieba.cut_for_search(cleaned):
        token = _FTS_UNSAFE_RE.sub("", raw.strip())
        if token:
            tokens.append(token)
    return tokens


def _dedupe(items: Iterable[str]) -> List[str]:
    seen = set()
    out = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def build_match_query(query: str, mode: str = "and") -> str:
    tokens = _dedupe(segment(query))
    if not tokens:
        return ""
    quoted = ['"%s"' % t.replace('"', "") for t in tokens]
    return (" AND " if mode == "and" else " OR ").join(quoted)


def split_sentences(text: str) -> List[str]:
    if not text:
        return []
    return [part.strip() for part in _SENT_SPLIT_RE.split(text) if part.strip()]


def chunk_text(text: str, target: int = CHUNK_TARGET_CHARS,
               overlap: int = CHUNK_OVERLAP_CHARS) -> List[str]:
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= target:
        return [text]

    chunks, current, current_len = [], [], 0
    for sentence in (split_sentences(text) or [text]):
        while len(sentence) > target:
            head, sentence = sentence[:target], sentence[target:]
            if current:
                chunks.append("".join(current))
                current, current_len = [], 0
            chunks.append(head)
        if current_len + len(sentence) > target and current:
            chunks.append("".join(current))
            tail = "".join(current)[-overlap:] if overlap > 0 else ""
            current, current_len = ([tail] if tail else []), len(tail)
        current.append(sentence)
        current_len += len(sentence)
    if current:
        chunks.append("".join(current))
    return [c.strip() for c in chunks if c.strip()]

