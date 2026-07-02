import "server-only"

function hasCjk(text: string) {
  return /[\u3400-\u9fff]/.test(text)
}

function normalizeReasoningText(value: unknown) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<\/?think[^>]*>/gi, " ")
    .replace(/<\|[^|]+?\|>/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim()
}

function splitSentences(text: string) {
  const sentences: string[] = []
  let current = ""
  for (const char of text) {
    current += char
    if ("。！？!?".includes(char)) {
      const sentence = current.trim()
      if (sentence) sentences.push(sentence)
      current = ""
    }
  }
  const tail = current.trim()
  if (tail) sentences.push(tail)
  return sentences
}

function trimActionNote(text: string) {
  let result = text
    .replace(/^[\s"'`>*\-•·。！？!?,，:：;；]+/, "")
    .replace(/[\s"'`<]+$/g, "")
    .trim()
  if (result && !/[。！？!?]$/.test(result)) result += "。"
  return result
}

function isLikelyNoisy(text: string) {
  const compact = text.replace(/\s/g, "")
  if (compact.length < 4) return true
  if (!hasCjk(compact)) return true
  if (/^\s*[\[{]/.test(text)) return true
  if (/```|<\|[^|]+?\|>/.test(text)) return true
  const noisyChars = text.match(/[{}[\]<>`=;|\\]/g)?.length || 0
  const slashChars = text.match(/[\\/]/g)?.length || 0
  const asciiWords = text.match(/[A-Za-z_][A-Za-z0-9_./:-]{8,}/g)?.length || 0
  return noisyChars / Math.max(compact.length, 1) > 0.18 ||
    slashChars >= 3 ||
    asciiWords >= 4
}

export function deriveVisibleActionNoteFromReasoning(reasoning: unknown) {
  const normalized = normalizeReasoningText(reasoning)
  if (!normalized || !hasCjk(normalized)) return ""
  const sentences = splitSentences(normalized)
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const candidate = trimActionNote(sentences[index])
    if (!candidate || isLikelyNoisy(candidate)) continue
    return candidate
  }
  return ""
}
