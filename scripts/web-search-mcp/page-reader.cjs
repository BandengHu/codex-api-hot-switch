"use strict"

const dns = require("node:dns").promises
const http = require("node:http")
const https = require("node:https")
const net = require("node:net")
const zlib = require("node:zlib")
const { extractPage } = require("./content-extractor.cjs")
const {
  cleanPositiveInteger,
  cleanString,
  isObject,
  timeoutMs,
  withTimeout,
} = require("./shared.cjs")

const MAX_PAGE_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5
const DEFAULT_MAX_CHARACTERS = 20_000
const MAX_CHARACTERS = 100_000

function parseIpv4(value) {
  const parts = value.split(".")
  if (parts.length !== 4) return null
  const numbers = parts.map((part) => Number.parseInt(part, 10))
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return numbers
}

function isForbiddenIpv4(value) {
  const parts = parseIpv4(value)
  if (!parts) return true
  const [a, b, c] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

function isForbiddenIpv6(value) {
  const normalized = value.toLowerCase().split("%")[0]
  if (normalized === "::" || normalized === "::1") return true
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length)
    if (net.isIP(mapped) === 4) return isForbiddenIpv4(mapped)
  }
  return (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8")
  )
}

function isForbiddenIp(value) {
  const version = net.isIP(value)
  if (version === 4) return isForbiddenIpv4(value)
  if (version === 6) return isForbiddenIpv6(value)
  return true
}

function normalizedHostname(url) {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
}

function validatePublicUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid URL: ${value}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`)
  }
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed")

  const hostname = normalizedHostname(url)
  if (
    !hostname ||
    hostname === "localhost" ||
    (!hostname.includes(".") && !net.isIP(hostname)) ||
    /\.(?:internal|invalid|lan|local|localdomain|localhost|test)$/i.test(hostname)
  ) {
    throw new Error(`Private or local hostname is not allowed: ${hostname || "(missing)"}`)
  }
  if (net.isIP(hostname) && isForbiddenIp(hostname)) {
    throw new Error(`Private or reserved IP address is not allowed: ${hostname}`)
  }
  return url
}

async function resolvePublicAddress(url) {
  const hostname = normalizedHostname(url)
  if (net.isIP(hostname)) return { address: hostname, family: net.isIP(hostname) }
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true })
  if (!addresses.length) throw new Error(`Could not resolve hostname: ${hostname}`)
  if (addresses.some((entry) => isForbiddenIp(entry.address))) {
    throw new Error(`Hostname resolves to a private or reserved address: ${hostname}`)
  }
  return addresses[0]
}

function requestResolvedUrl(url, address, signal) {
  const transport = url.protocol === "https:" ? https : http
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: address.address,
        family: address.family,
        port: url.port || undefined,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        servername: url.protocol === "https:" ? normalizedHostname(url) : undefined,
        signal,
        headers: {
          accept: "text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.8,*/*;q=0.2",
          "accept-encoding": "gzip, deflate, br",
          host: url.host,
          "user-agent": "Codex-SwitchGate-PageReader/0.2",
        },
      },
      (response) => {
        const chunks = []
        let total = 0
        response.on("data", (chunk) => {
          total += chunk.length
          if (total > MAX_PAGE_BYTES) {
            response.destroy(new Error(`browse_page response exceeded ${MAX_PAGE_BYTES} bytes`))
            return
          }
          chunks.push(chunk)
        })
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks, total),
          })
        })
        response.on("error", reject)
      },
    )
    request.on("error", reject)
    request.end()
  })
}

function headerValue(value) {
  if (Array.isArray(value)) return value.join(", ")
  return cleanString(value)
}

function decodeContentEncoding(body, encodingValue) {
  const encoding = cleanString(encodingValue).toLowerCase()
  const options = { maxOutputLength: MAX_PAGE_BYTES }
  if (!encoding || encoding === "identity") return body
  if (encoding === "gzip" || encoding === "x-gzip") return zlib.gunzipSync(body, options)
  if (encoding === "deflate") return zlib.inflateSync(body, options)
  if (encoding === "br") return zlib.brotliDecompressSync(body, options)
  throw new Error(`browse_page does not support content encoding: ${encoding}`)
}

async function fetchPublicPage(value, signal) {
  let current = validatePublicUrl(value)
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const address = await resolvePublicAddress(current)
    const response = await requestResolvedUrl(current, address, signal)
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = headerValue(response.headers.location)
      if (!location) throw new Error(`Redirect from ${current} did not include a Location header`)
      if (redirectCount === MAX_REDIRECTS) {
        throw new Error(`browse_page exceeded ${MAX_REDIRECTS} redirects`)
      }
      current = validatePublicUrl(new URL(location, current).toString())
      continue
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`browse_page returned HTTP ${response.statusCode} for ${current}`)
    }
    return {
      ...response,
      body: decodeContentEncoding(response.body, headerValue(response.headers["content-encoding"])),
      finalUrl: current.toString(),
    }
  }
  throw new Error(`browse_page exceeded ${MAX_REDIRECTS} redirects`)
}

function normalizeBrowsePageInput(argumentsValue) {
  if (!isObject(argumentsValue)) throw new Error("browse_page arguments must be an object")
  const singleUrl = cleanString(argumentsValue.url)
  const arrayUrls = Array.isArray(argumentsValue.urls)
    ? argumentsValue.urls.map(cleanString).filter(Boolean)
    : []
  const urls = [...new Set(singleUrl ? [singleUrl, ...arrayUrls] : arrayUrls)]
  if (!urls.length) throw new Error("browse_page requires url or urls")
  if (urls.length > 5) throw new Error("browse_page accepts at most 5 URLs per call")
  for (const url of urls) validatePublicUrl(url)
  return {
    urls,
    maxCharacters: cleanPositiveInteger(
      argumentsValue.maxCharacters,
      DEFAULT_MAX_CHARACTERS,
      1000,
      MAX_CHARACTERS,
    ),
  }
}

async function browsePage(url, maxCharacters, signal) {
  const timeout = withTimeout(
    signal,
    timeoutMs("SWITCHGATE_BROWSE_PAGE_TIMEOUT_MS", 25_000),
  )
  try {
    const response = await fetchPublicPage(url, timeout.signal)
    return extractPage(
      response.body,
      headerValue(response.headers["content-type"]),
      response.finalUrl,
      maxCharacters,
    )
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`browse_page timed out for ${url}`)
    }
    throw error
  } finally {
    timeout.done()
  }
}

async function executeBrowsePage(input, signal) {
  const settled = await Promise.allSettled(
    input.urls.map((url) => browsePage(url, input.maxCharacters, signal)),
  )
  const pages = settled.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : {
          url: input.urls[index],
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
  )
  if (settled.every((result) => result.status === "rejected")) {
    throw new Error(
      `browse_page could not read any requested URL: ${pages.map((page) => page.error).join("; ")}`,
    )
  }
  return { pageCount: pages.filter((page) => !page.error).length, pages }
}

module.exports = {
  decodeContentEncoding,
  executeBrowsePage,
  isForbiddenIp,
  normalizeBrowsePageInput,
  validatePublicUrl,
}
