"""把 PDF 资料合集按页拆成可检索文档。

为什么按页而不是按文档切分：
这份 PDF 是多个 PPT 直接拼起来的（1728 页、781 种不同的首行），
没有书签、页码序列也反复重置，实测用「页码不连续」做边界会得到 1005 个
假边界。按页拆不会切错任何一份材料，命中结果带真实页码，可以直接回原文件核对。

空白页（纯图表页，文字提取不到）直接跳过，免得污染检索。

用法：
  python tools/kb/parse_pdf.py --pdf <路径> --out build/kb/pdf.json
"""

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

import fitz

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 少于这个字符数就认为这页没有可检索文字（图表页、封面留白）
MIN_CHARS = 40

PAGE_NO_RE = re.compile(r"^\d{1,4}$")
SPACE_RE = re.compile(r"[ \t\u3000]+")


def page_text(page) -> str:
    text = page.get_text().strip()
    if not text:
        return ""
    lines = [line.strip() for line in text.splitlines()]
    kept = []
    for line in lines:
        if not line:
            continue
        # 单独一行纯数字几乎都是 PPT 页码，检索时没有意义
        if PAGE_NO_RE.match(line):
            continue
        kept.append(line)
    return "\n".join(kept).strip()


def guess_title(pages, index: int) -> str:
    """用本页第一个像标题的行命名，方便命中后一眼看出是什么材料。"""
    for line in pages[index].splitlines():
        line = line.strip()
        if 4 <= len(line) <= 60 and not PAGE_NO_RE.match(line):
            return line
    return "第 %d 页" % (index + 1)


def parse(pdf_path: str):
    document = fitz.open(pdf_path)
    pages = []
    skipped = 0
    for number in range(document.page_count):
        text = page_text(document[number])
        if len(text) < MIN_CHARS:
            skipped += 1
            pages.append("")
            continue
        pages.append(text)
    return document.page_count, pages, skipped


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    started = time.time()
    total_pages, pages, skipped = parse(args.pdf)
    print("总页数 = %d  空白/图表页跳过 = %d  保留 = %d" % (
        total_pages, skipped, total_pages - skipped))

    documents = []
    for index, text in enumerate(pages):
        if not text:
            continue
        documents.append({
            "external_id": "p%d" % (index + 1),
            "title": guess_title(pages, index),
            "meta": {"pdf_page": index + 1, "source": "算网运营认证专区_PDF资料合集.pdf"},
            "blocks": [{"heading": "第 %d 页" % (index + 1), "text": text}],
        })

    payload = {
        "title": "联通党校 · 算网运营认证专区（PDF 原始资料）",
        "description": "AI 未经加工的原始 PPT 材料，按页拆分，元数据带真实页码。内容最可信。",
        "source": str(args.pdf),
        "documents": documents,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)

    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    chars = sum(len(d["blocks"][0]["text"]) for d in documents)
    print("documents = %d  字符 = %d" % (len(documents), chars))
    print("out %s  %.1f MB  sha=%s" % (out, out.stat().st_size / 1048576, digest[:16]))
    print("elapsed %.1fs" % (time.time() - started))
