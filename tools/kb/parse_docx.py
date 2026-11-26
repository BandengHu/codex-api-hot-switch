"""把「课程知识总汇编」docx 解析成结构化 JSON。

docx 是按 认证方向 → 专业分类 → 课程 → 视频 排版的，
每个视频固定五段：内容摘要 / 知识点 / 语音转录文字（全文）/ 重要结论，
PDF 类课程另有「PDF 资料摘要」。

输出 items，每项是一篇可独立检索的文档：
- 课程摘要 + 知识点清单（整门课一份）
- 每个视频一份：摘要、知识点、转录全文、重要结论
- PDF 资料摘要（整门课一份）

用法：
  python tools/kb/parse_docx.py --docx <路径> --out build/kb/transcripts.json
"""

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

import docx

from clean_transcript import clean as clean_transcript

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

COURSE_RE = re.compile(r"^课程 ID：(\d+)\s*｜\s*学时：([\d.]+)\s*｜\s*类型：(\w+)\s*｜\s*条目数：(\d+)$")
VIDEO_RE = re.compile(r"^视频\s*(\d+)：(.+)$")
NUMBER_RE = re.compile(r"^(\d+(?:\.\d+)*)[　\s]+(.+)$")

# 视频小节内部的固定小标题，用来切段
VIDEO_LABELS = ("内容摘要", "知识点", "语音转录文字（全文）", "重要结论")


def heading_text(paragraph) -> str:
    return paragraph.text.strip().replace("\u3000", " ").strip()


def parse(docx_path: str):
    document = docx.Document(docx_path)
    paragraphs = document.paragraphs

    items = []
    chapter = ""       # 第1章 云网工程师认证
    category = ""      # 1.2 国际网
    course = None      # 当前课程
    video = None       # 当前视频
    section = ""       # 当前正在收集的小节名
    in_catalog = True  # 目录部分跳过

    def flush_video():
        nonlocal video
        if video is not None and course is not None:
            items.append(video)
            course["videos"].append(video)
        video = None

    def flush_course():
        nonlocal course
        flush_video()
        if course is not None:
            items.append(course)
        course = None

    for paragraph in paragraphs:
        text = heading_text(paragraph)
        style = paragraph.style.name if paragraph.style else "Normal"

        if not text:
            continue

        # 目录里也用了 Heading 2，正文从第一个 Heading 1 开始
        if style == "Heading 1":
            in_catalog = False
            flush_course()
            chapter = text
            section = ""
            continue
        if in_catalog:
            continue

        if style == "Heading 2":
            flush_course()
            match = NUMBER_RE.match(text)
            category = match.group(2).strip() if match else text
            section = ""
            continue

        if style == "Heading 3":
            flush_course()
            match = NUMBER_RE.match(text)
            title = match.group(2).strip() if match else text
            course = {
                "kind": "course",
                "external_id": "",
                "title": title,
                "meta": {"chapter": chapter, "category": category, "number": text.split(" ")[0]},
                "blocks": [],
                "course_id": "",
                "course_hour": "",
                "course_type": "",
                "videos": [],
                "overview": [],
                "points": [],
                "pdf_summary": [],
                "missing": [],
            }
            section = ""
            continue

        if style == "Heading 4" and course is not None:
            flush_video()
            match = VIDEO_RE.match(text)
            number = match.group(1) if match else ""
            name = match.group(2).strip() if match else text
            video = {
                "kind": "video",
                "external_id": "%s-v%s" % (course["course_id"] or "?", number or len(course["videos"]) + 1),
                "title": "%s（视频%s）" % (course["title"], number or "?") if name in course["title"] else name,
                "meta": {"chapter": chapter, "category": category, "course": course["title"]},
                "blocks": [],
                "duration": "",
                "summary": [],
                "points": [],
                "transcript": [],
                "conclusion": [],
            }
            section = ""
            continue

        # ---- 正文 ----
        match = COURSE_RE.match(text)
        if match and course is not None:
            course["course_id"] = match.group(1)
            course["course_hour"] = match.group(2)
            course["course_type"] = match.group(3)
            course["external_id"] = match.group(1)
            course["meta"].update({
                "course_id": match.group(1),
                "course_hour": match.group(2),
                "course_type": match.group(3),
                "entries": int(match.group(4)),
            })
            continue

        if video is not None:
            if text in VIDEO_LABELS:
                section = text
                continue
            if text.startswith("时长"):
                video["duration"] = text
                continue
            target = {
                "内容摘要": video["summary"],
                "知识点": video["points"],
                "语音转录文字（全文）": video["transcript"],
                "重要结论": video["conclusion"],
            }.get(section)
            if target is not None:
                target.append(text)
            continue

        if course is not None:
            if text == "课程内容摘要":
                section = "overview"
                continue
            if text == "课程知识点清单（汇总）":
                section = "points"
                continue
            if text == "视频逐条解析":
                section = ""
                continue
            if text == "PDF 资料摘要":
                section = "pdf"
                continue
            if text == "缺失说明":
                section = "missing"
                continue
            target = {
                "overview": course["overview"],
                "points": course["points"],
                "pdf": course["pdf_summary"],
                "missing": course["missing"],
            }.get(section)
            if target is not None:
                target.append(text)

    flush_course()
    return items


def join(lines):
    return "\n".join(line for line in lines if line.strip()).strip()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--docx", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--no-clean", action="store_true", help="保留原始口语与时间戳")
    args = parser.parse_args()

    started = time.time()
    data = parse(args.docx)
    courses = [x for x in data if x["kind"] == "course"]
    videos = [x for x in data if x["kind"] == "video"]

    raw_transcript = sum(len(join(v["transcript"])) for v in videos)
    if not args.no_clean:
        for video in videos:
            video["transcript"] = [clean_transcript(line) for line in video["transcript"]]
            video["transcript"] = [line for line in video["transcript"] if line]

    print("courses = %d  videos = %d" % (len(courses), len(videos)))
    with_transcript = [v for v in videos if join(v["transcript"]) and not join(v["transcript"]).startswith("该条目")]
    print("有转录的视频 = %d" % len(with_transcript))
    cleaned_transcript = sum(len(join(v["transcript"])) for v in videos)
    print("转录字符 原始=%d 清洗后=%d (%.0f%%)" % (
        raw_transcript, cleaned_transcript,
        100.0 * cleaned_transcript / max(raw_transcript, 1)))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    # 展开成可检索文档
    documents = []
    for course in courses:
        blocks = []
        overview = join(course["overview"])
        if overview:
            blocks.append({"heading": "课程内容摘要", "text": overview})
        if course["points"]:
            blocks.append({"heading": "课程知识点清单", "text": "\n".join("- " + p for p in course["points"])})
        if course["pdf_summary"]:
            blocks.append({"heading": "PDF 资料摘要", "text": join(course["pdf_summary"])})
        if course["missing"]:
            blocks.append({"heading": "缺失说明", "text": join(course["missing"])})
        if blocks:
            documents.append({
                "external_id": course["course_id"],
                "title": course["title"],
                "meta": course["meta"],
                "blocks": blocks,
            })

        for video in course["videos"]:
            video_blocks = []
            if video["summary"]:
                video_blocks.append({"heading": "本条目内容摘要", "text": join(video["summary"])})
            if video["points"]:
                video_blocks.append({"heading": "本条目知识点", "text": "\n".join("- " + p for p in video["points"])})
            if video["transcript"]:
                video_blocks.append({"heading": "语音转录", "text": join(video["transcript"])})
            if video["conclusion"]:
                video_blocks.append({"heading": "重要结论", "text": join(video["conclusion"])})
            if not video_blocks:
                continue
            documents.append({
                "external_id": video["external_id"],
                "title": "%s · %s" % (course["title"], video["title"]),
                "meta": dict(video["meta"], duration=video["duration"]),
                "blocks": video_blocks,
            })

    payload = {
        "title": "联通党校 · 算网运营认证专区（语音转录）",
        "description": "698 门课程的语音转录全文与逐条解析，按视频拆分成独立文档。",
        "source": str(args.docx),
        "documents": documents,
    }
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)

    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    print("documents = %d" % len(documents))
    print("out %s  %.1f MB  sha=%s" % (out, out.stat().st_size / 1048576, digest[:16]))
    print("elapsed %.1fs" % (time.time() - started))
