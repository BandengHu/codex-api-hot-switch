"""本地构建知识库索引：编码向量 + 生成上传包。

为什么在本地算向量：
- 服务器 3.5G 内存、无 GPU，跑 1.6 万次编码要 20 分钟并挤占线上服务
- sqlite-vec 在该数据量上 kNN 查询会卡死（实测 100% CPU > 100 秒）
因此本地编码、导出 float32 矩阵，服务器只做矩阵点积，毫秒级返回。

用法：
  python tools/kb/build_index.py --job jobs/lianTongPartySchool.json --out build/kb
"""

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Dict, List

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import text  # noqa: E402
from embedder import Embedder  # noqa: E402


def load_items(job: Dict) -> List[Dict]:
    input_path = job["input"]
    if not os.path.isabs(input_path):
        input_path = os.path.abspath(input_path)
    if not os.path.isfile(input_path):
        raise SystemExit("输入文件不存在: %s (cwd=%s)" % (input_path, os.getcwd()))
    with open(input_path, encoding="utf-8") as handle:
        payload = json.load(handle)
    if isinstance(payload, dict) and isinstance(payload.get("courses"), list):
        courses = payload["courses"]
        # 全量文件里 courses 直接是课程对象数组；
        # 若给的是 manifest（每项只有 file 字段），再按 items_from 逐文件读
        if courses and isinstance(courses[0], dict) and "file" in courses[0]:
            base = job.get("items_from") or os.path.dirname(input_path)
            items = []
            for entry in courses:
                with open(os.path.join(base, entry["file"]), encoding="utf-8") as handle:
                    items.append(json.load(handle))
            return items
        return courses
    if isinstance(payload, dict) and isinstance(payload.get("items"), list):
        return payload["items"]
    if isinstance(payload, list):
        return payload
    raise SystemExit("无法解析 items: %s" % input_path)


def build_blocks(item: Dict) -> List[Dict[str, str]]:
    """按语义小节切段，保留标题用于定位。"""
    blocks = []
    overview = (item.get("overview") or "").strip()
    if overview:
        blocks.append({"heading": "课程概述", "text": overview})

    for section in item.get("sections") or []:
        heading = (section.get("heading") or "").strip()
        lines = [str(x).strip() for x in (section.get("items") or []) if str(x).strip()]
        if not lines and not heading:
            continue
        body = "\n".join("- " + line for line in lines) if lines else heading
        blocks.append({"heading": heading or "正文", "text": body})

    exam_points = [str(x).strip() for x in (item.get("exam_points") or []) if str(x).strip()]
    if exam_points:
        blocks.append({"heading": "考点速记", "text": "\n".join("- " + line for line in exam_points)})

    keywords = [str(x).strip() for x in (item.get("keywords") or []) if str(x).strip()]
    if keywords:
        blocks.append({"heading": "关键词", "text": "、".join(keywords)})

    if not blocks:
        for key in ("summary", "content", "text", "raw"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                blocks.append({"heading": "", "text": value.strip()})
                break
    return blocks


def build_body(blocks: List[Dict[str, str]]) -> str:
    parts = []
    for block in blocks:
        heading = block["heading"]
        parts.append(("【%s】\n%s" % (heading, block["text"])) if heading else block["text"])
    return "\n\n".join(parts).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default=str(Path(".codex-tmp/models/bge-small-zh-onnx")))
    args = parser.parse_args()

    started = time.time()
    job = json.load(open(args.job, encoding="utf-8"))
    items = load_items(job)
    print("items = %d" % len(items))

    embedder = Embedder(args.model)

    docs = []
    all_chunks: List[str] = []
    all_headings: List[str] = []
    chunk_doc = []

    for index, item in enumerate(items):
        blocks = build_blocks(item)
        if not blocks:
            continue
        body = build_body(blocks)
        doc_index = len(docs)
        docs.append({
            "external_id": str(item.get(job.get("id_field", "course_id")) or ""),
            "title": item.get(job.get("title_field", "course_name")) or "item-%d" % index,
            "raw": body,
            "meta": {
                k: v for k, v in item.items()
                if isinstance(v, (str, int, float, bool)) or (
                    isinstance(v, list) and all(isinstance(x, (str, int, float)) for x in v)
                )
            },
        })
        for block in blocks:
            for chunk in text.chunk_text(block["text"]):
                all_chunks.append(chunk)
                all_headings.append(block["heading"])
                chunk_doc.append(doc_index)

    print("docs = %d  chunks = %d" % (len(docs), len(all_chunks)))

    # 编码：标题并入正文一起编码，提升「按标题提问」命中率
    to_encode = [
        (heading + "\n" + chunk) if heading else chunk
        for heading, chunk in zip(all_headings, all_chunks)
    ]
    t0 = time.time()
    vectors = embedder.encode(to_encode, batch_size=32)
    print("encode %.1fs (%.1f chunks/s) dim = %d" % (
        time.time() - t0, len(to_encode) / max(time.time() - t0, 1e-6), vectors.shape[1]))

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    payload = {
        "library": job["library"],
        "title": job["title"],
        "description": job.get("description", ""),
        "source": job.get("source", ""),
        "model": Path(args.model).name,
        "dim": int(vectors.shape[1]),
        "docs": docs,
        "chunks": [
            {"document": chunk_doc[i], "ordinal": i, "heading": all_headings[i], "content": all_chunks[i]}
            for i in range(len(all_chunks))
        ],
    }
    index_path = out_dir / ("%s.index.json" % job["library"])
    with open(index_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)

    vector_path = out_dir / ("%s.vectors.npz" % job["library"])
    np.savez_compressed(
        vector_path,
        chunk_ids=np.arange(len(all_chunks), dtype=np.int64),
        vectors=vectors.astype(np.float32),
    )

    def sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
        return digest.hexdigest()

    print("index  %8.1f MB  sha=%s" % (index_path.stat().st_size / 1048576, sha256(index_path)[:16]))
    print("vector %8.1f MB  sha=%s" % (vector_path.stat().st_size / 1048576, sha256(vector_path)[:16]))
    print("total  %.1fs" % (time.time() - started))


if __name__ == "__main__":
    main()

