"use strict"

const {
  cleanString,
  compactWhitespace,
  domainFromUrl,
  isObject,
  normalizePublishedAt,
} = require("./shared.cjs")

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "blockquote",
  "br",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
])
const SKIP_TAGS = new Set([
  "aside",
  "canvas",
  "footer",
  "form",
  "nav",
  "noscript",
  "style",
  "svg",
  "template",
])
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
])

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    laquo: "«",
    ldquo: "“",
    lrm: "",
    nbsp: " ",
    quot: '"',
    raquo: "»",
    rdquo: "”",
    rlm: "",
    rsquo: "’",
    lsquo: "‘",
    lt: "<",
    mdash: "—",
    ndash: "–",
  }
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x"
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
      if (Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        return String.fromCodePoint(codePoint)
      }
      return ""
    }
    return Object.prototype.hasOwnProperty.call(named, entity.toLowerCase())
      ? named[entity.toLowerCase()]
      : match
  })
}

function parseAttributes(source) {
  const attributes = {}
  let index = 0
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1
    if (index >= source.length || source[index] === "/" || source[index] === ">") break
    const nameStart = index
    while (index < source.length && !/[\s=/>]/.test(source[index])) index += 1
    const name = source.slice(nameStart, index).toLowerCase()
    while (index < source.length && /\s/.test(source[index])) index += 1
    let value = ""
    if (source[index] === "=") {
      index += 1
      while (index < source.length && /\s/.test(source[index])) index += 1
      const quote = source[index] === '"' || source[index] === "'" ? source[index++] : ""
      const valueStart = index
      if (quote) {
        while (index < source.length && source[index] !== quote) index += 1
        value = source.slice(valueStart, index)
        if (source[index] === quote) index += 1
      } else {
        while (index < source.length && !/[\s>]/.test(source[index])) index += 1
        value = source.slice(valueStart, index)
      }
    }
    if (name) attributes[name] = decodeHtmlEntities(value)
  }
  return attributes
}

function findTagEnd(html, start) {
  let quote = ""
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]
    if (quote) {
      if (character === quote) quote = ""
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === ">") return index
  }
  return -1
}

function normalizeExtractedText(value) {
  return value
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter((line, index, lines) => line && line !== lines[index - 1])
    .join("\n")
    .trim()
}

function collectJsonLd(value, metadata) {
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonLd(entry, metadata)
    return
  }
  if (!isObject(value)) return
  if (!metadata.title) metadata.title = cleanString(value.headline || value.name)
  if (!metadata.publishedAt) {
    metadata.publishedAt = normalizePublishedAt(
      value.datePublished || value.dateCreated || value.dateModified,
    )
  }
  for (const entry of Object.values(value)) collectJsonLd(entry, metadata)
}

function parseHtmlDocument(html) {
  const lowerHtml = html.toLowerCase()
  const stack = []
  const buffers = { article: [], body: [], h1: [], main: [], title: [] }
  const metadata = { title: "", publishedAt: null }
  const metaValues = {}
  let index = 0

  function appendBreak() {
    if (stack.some((entry) => entry.skip)) return
    buffers.body.push("\n")
    if (stack.some((entry) => entry.name === "article")) buffers.article.push("\n")
    if (stack.some((entry) => entry.name === "main")) buffers.main.push("\n")
  }

  function appendText(raw) {
    const text = decodeHtmlEntities(raw)
    if (!text || stack.some((entry) => entry.skip)) return
    buffers.body.push(text)
    if (stack.some((entry) => entry.name === "article")) buffers.article.push(text)
    if (stack.some((entry) => entry.name === "main")) buffers.main.push(text)
    if (stack.some((entry) => entry.name === "title")) buffers.title.push(text)
    if (stack.some((entry) => entry.name === "h1")) buffers.h1.push(text)
  }

  while (index < html.length) {
    const top = stack[stack.length - 1]
    if (top?.name === "script") {
      const closeIndex = lowerHtml.indexOf("</script", index)
      const raw = html.slice(index, closeIndex < 0 ? html.length : closeIndex)
      if (top.jsonLd) {
        try {
          collectJsonLd(JSON.parse(raw.trim()), metadata)
        } catch {
          // Malformed structured metadata does not invalidate visible page text.
        }
      }
      if (closeIndex < 0) break
      index = closeIndex
    }

    const tagStart = html.indexOf("<", index)
    if (tagStart < 0) {
      appendText(html.slice(index))
      break
    }
    appendText(html.slice(index, tagStart))
    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4)
      index = commentEnd < 0 ? html.length : commentEnd + 3
      continue
    }
    const tagEnd = findTagEnd(html, tagStart + 1)
    if (tagEnd < 0) break
    const rawTag = html.slice(tagStart + 1, tagEnd).trim()
    index = tagEnd + 1
    if (!rawTag || rawTag.startsWith("!") || rawTag.startsWith("?")) continue

    const closing = rawTag.startsWith("/")
    const tagSource = closing ? rawTag.slice(1).trim() : rawTag
    const nameMatch = tagSource.match(/^([a-zA-Z][\w:-]*)/)
    if (!nameMatch) continue
    const name = nameMatch[1].toLowerCase()
    if (closing) {
      if (BLOCK_TAGS.has(name)) appendBreak()
      const stackIndex = stack.map((entry) => entry.name).lastIndexOf(name)
      if (stackIndex >= 0) stack.splice(stackIndex)
      continue
    }

    const attributes = parseAttributes(tagSource.slice(nameMatch[0].length))
    if (name === "meta") {
      const key = cleanString(
        attributes.property || attributes.name || attributes.itemprop || attributes["http-equiv"],
      ).toLowerCase()
      const content = cleanString(attributes.content)
      if (key && content && !metaValues[key]) metaValues[key] = content
    }
    if (BLOCK_TAGS.has(name)) appendBreak()
    if (VOID_TAGS.has(name) || rawTag.endsWith("/")) continue
    const inheritedSkip = stack.some((entry) => entry.skip)
    stack.push({
      name,
      skip:
        inheritedSkip ||
        SKIP_TAGS.has(name) ||
        (name === "script" && attributes.type !== "application/ld+json"),
      jsonLd: name === "script" && attributes.type === "application/ld+json",
    })
  }

  const title =
    cleanString(metaValues["og:title"]) ||
    cleanString(metaValues["twitter:title"]) ||
    normalizeExtractedText(buffers.title.join("")) ||
    normalizeExtractedText(buffers.h1.join(""))
  const publishedAt =
    normalizePublishedAt(
      metaValues["article:published_time"] ||
        metaValues.datepublished ||
        metaValues.date ||
        metaValues.pubdate ||
        metaValues["dc.date"] ||
        metaValues["dc.date.issued"],
    ) || metadata.publishedAt
  const article = normalizeExtractedText(buffers.article.join(""))
  const main = normalizeExtractedText(buffers.main.join(""))
  const body = normalizeExtractedText(buffers.body.join(""))
  return {
    title: title || metadata.title,
    publishedAt,
    text: article.length >= 500 ? article : main.length >= 500 ? main : body,
  }
}

function decodeBody(body, contentType) {
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] || "utf-8"
  try {
    return new TextDecoder(charset).decode(body)
  } catch {
    return new TextDecoder("utf-8").decode(body)
  }
}

function detectMediaType(contentType, body, decoded) {
  const explicit = cleanString(contentType).split(";")[0].toLowerCase()
  if (explicit) {
    if (
      explicit.startsWith("text/") ||
      explicit === "application/json" ||
      explicit === "application/ld+json" ||
      explicit === "application/xhtml+xml" ||
      explicit === "application/xml"
    ) {
      return explicit
    }
    throw new Error(`browse_page does not support content type: ${contentType}`)
  }
  if (body.includes(0)) throw new Error("browse_page received binary content without a content type")
  const trimmed = decoded.trimStart()
  if (trimmed.startsWith("<")) return "text/html"
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "application/json"
  return "text/plain"
}

function extractPage(body, contentType, finalUrl, maxCharacters) {
  const decoded = decodeBody(body, contentType)
  const mediaType = detectMediaType(contentType, body, decoded)
  let extracted
  if (
    mediaType === "text/html" ||
    mediaType === "application/xhtml+xml" ||
    mediaType === "application/xml"
  ) {
    extracted = parseHtmlDocument(decoded)
  } else {
    let text = decoded
    let title = ""
    let publishedAt = null
    if (mediaType === "application/json" || mediaType === "application/ld+json") {
      try {
        const value = JSON.parse(decoded)
        const metadata = { title: "", publishedAt: null }
        collectJsonLd(value, metadata)
        title = metadata.title
        publishedAt = metadata.publishedAt
        text = JSON.stringify(value, null, 2)
      } catch {
        // Preserve mislabeled JSON as readable upstream text.
      }
    }
    extracted = { title, publishedAt, text: normalizeExtractedText(text) }
  }
  const truncated = extracted.text.length > maxCharacters
  return {
    url: finalUrl,
    domain: domainFromUrl(finalUrl),
    title: compactWhitespace(extracted.title) || domainFromUrl(finalUrl),
    publishedAt: extracted.publishedAt || null,
    contentType: mediaType,
    text: extracted.text.slice(0, maxCharacters),
    truncated,
  }
}

module.exports = {
  collectJsonLd,
  extractPage,
  normalizeExtractedText,
  parseHtmlDocument,
}
