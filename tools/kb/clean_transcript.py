"""清洗语音转录：去时间戳、去口语语气词。

为什么要清洗：转录是逐句口语，充满「呃」「那么」「这个」「就是说」，
直接入向量库会把一句话的有效信息稀释掉一大半，检索时同义句反而更相近。

清洗只删语气词和口水话，不改动任何实词，也不重写语序：
原句「那么首先呢在这个我们开始呃正式的这个培训之前呢」→「首先在我们开始正式培训之前」。

刻意不做的事情：
- 不折叠 ASR 卡顿重复。实测 42 万处里大半是数字（`8799`→`879`）、
  英文缩写（`mme`→`me`、`3gpp`→`3gp`）和正常叠词（`谢谢`→`谢`、`仅仅`→`仅`），
  压完术语检索直接失效。重复字在 FTS 里本来就是同一个 token，留着不影响召回。
- 不做同义词替换、不改语序、不删实词。

用法：由 parse_docx / build_index 调用，也可单独跑：
  python tools/kb/clean_transcript.py --text "呃，那么我们今天讲这个"
"""

import argparse
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# [00:14] [1:02:33] 这样的时间戳
TIMESTAMP_RE = re.compile(r"\[\d{1,2}:\d{2}(?::\d{2})?\]")

# 「共 1207 段，按时间戳顺序分组排列。」这类说明行
NOTE_RE = re.compile(r"^共\s*\d+\s*段[，,].*$")

# 无实义的单字语气词。这些字在中文里不参与构词，删掉不会改变任何语义。
SINGLE_FILLER_RE = re.compile(r"[呃嗯哦唉诶欸]")

# 「额」有实词用法（利润总额 / 金额 / 额度 / 名额），只在两侧都不是汉字时才当语气词。
E_FILLER_RE = re.compile(r"(?<![\u4e00-\u9fff])额(?![\u4e00-\u9fff])")

# 多字口头禅：整词删掉不改变语义。
#
# 刻意不收的（都会改变语义，一律保留原文）：
#   这个 / 那个      指示代词，是实词，删了「这个参数」就剩「参数」
#   的话呢           条件句标记，「如果下雨的话呢」删成「如果下雨」丢了句式
#   好不好           实义评价，「做的好不好」实测 70 次里大半不是语气词
#   我们讲 / 大家看   承担句子结构，删了「我们讲一下这个参数」变成「一下参数」
MULTI_FILLER_PATTERNS = (
    # 「也就是说」「还就是说」里的「就是说」是正常连接词，删了会变成「也就，防破坏能力」
    r"(?<![也就还])就是说",
    r"那么",
    r"所以说",
    r"然后呢",
    r"对吧",
    r"是吧",
    r"对不对",
    r"你知道吧",
)
MULTI_FILLER_RE = re.compile("|".join(MULTI_FILLER_PATTERNS))

# 句尾语气词：只在紧跟标点或行尾时删。
# 加 lookbehind 是因为「呢」参与构词：「花呢」「毛呢」「粗呢」是面料，删掉只剩「花」。
TAIL_RE = re.compile(r"(?<![花毛线粗精])(?:呢|吧|嘛|呀|哈|啊|呗)(?=[，。、；：！？,.;:!?]|$)")

# ASR 把专业词听错。只在词边界干净的场景替换，且都是本课程领域的高频词。
ASR_FIXES = [
    ("海冷", "海缆"), ("排冷", "海缆"), ("海胆", "海缆"), ("海览", "海缆"),
    ("溶接", "熔接"), ("总类轮接", "熔接"), ("融接", "熔接"),
    ("高起来之后", "捞起来之后"), ("把故障海缆高起来", "把故障海缆捞起来"),
    ("新道", "信道"), ("新息", "信息"), ("新令", "信令"),
    ("排缆故障", "海缆故障"), ("排冷故障", "海缆故障"),
]


def _fix_asr(text: str) -> str:
    for wrong, right in ASR_FIXES:
        text = text.replace(wrong, right)
    return text


SPACE_RE = re.compile(r"[ \t\u3000]+")
BLANK_LINES_RE = re.compile(r"\n{3,}")
# 清理后可能留下的悬空标点：「特别注意啊，对不对？施工」删掉语气词会留下「，？」。
# 保留前一个、吃掉后一个：「，？」→「，」。
DANGLING_RE = re.compile(r"([，。、；：,.;:？！!?])\s*([，。、；：,.;:？！!?])+")


def clean_line(line: str) -> str:
    text = TIMESTAMP_RE.sub(" ", line)
    if NOTE_RE.match(text.strip()):
        return ""
    text = MULTI_FILLER_RE.sub("", text)
    text = SINGLE_FILLER_RE.sub("", text)
    text = E_FILLER_RE.sub("", text)
    text = TAIL_RE.sub("", text)
    text = _fix_asr(text)
    text = SPACE_RE.sub(" ", text)
    text = DANGLING_RE.sub(r"\1", text)
    text = text.strip(" ，、；：,;:？！。!?")
    return text.strip()


def clean(text: str) -> str:
    if not text:
        return ""
    lines = [clean_line(line) for line in text.splitlines()]
    kept = [line for line in lines if line]
    # 相邻重复句去掉（转录里常见「好的好的」「来看来看」）
    deduped = []
    for line in kept:
        if deduped and line == deduped[-1]:
            continue
        deduped.append(line)
    out = BLANK_LINES_RE.sub("\n\n", "\n".join(deduped)).strip()
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", default=None)
    parser.add_argument("--in", dest="src", default=None)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    if args.text:
        print(clean(args.text))
        return
    if not args.src:
        raise SystemExit("需要 --text 或 --in")
    raw = open(args.src, encoding="utf-8").read()
    cleaned = clean(raw)
    if args.out:
        open(args.out, "w", encoding="utf-8").write(cleaned)
        print("in %d chars -> out %d chars (%.0f%%)" % (
            len(raw), len(cleaned), 100.0 * len(cleaned) / max(len(raw), 1)))
    else:
        print(cleaned)


if __name__ == "__main__":
    main()

