"use strict"

const {
  cleanString,
  isObject,
  readFetchResponseText,
  withTimeout,
} = require("./shared.cjs")

const DEFAULT_API_URL = "http://127.0.0.1:8787/api/web-search"

function apiUrl() {
  return (
    cleanString(process.env.SWITCHGATE_WEB_API_URL) ||
    DEFAULT_API_URL
  ).replace(/\/+$/, "")
}

function errorFromPayload(payload, status) {
  const error = isObject(payload) && isObject(payload.error) ? payload.error : payload
  const code = isObject(error) && cleanString(error.code)
  const message = isObject(error) && cleanString(error.message)
  const provider = isObject(error) && cleanString(error.provider)
  const suffix = [code, provider].filter(Boolean).join("/")
  return new Error(
    `web_search ${status ? `HTTP ${status}` : "请求失败"}${suffix ? ` [${suffix}]` : ""}: ${
      message || "SwitchGate Web API returned an error"
    }`,
  )
}

async function postWebApi(operation, body, signal) {
  const timeout = withTimeout(signal, 30_000)
  try {
    const response = await fetch(apiUrl(), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation, ...body }),
      signal: timeout.signal,
    })
    const text = await readFetchResponseText(
      response,
      2 * 1024 * 1024,
      "SwitchGate Web API",
    )
    let payload
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      throw new Error("SwitchGate Web API returned invalid JSON")
    }
    if (!response.ok) throw errorFromPayload(payload, response.status)
    if (isObject(payload) && payload.error) throw errorFromPayload(payload)
    return payload
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("SwitchGate Web API timed out")
    }
    throw error
  } finally {
    timeout.done()
  }
}

module.exports = {
  postWebApi,
}
