"use strict"

const crypto = require("node:crypto")

const SESSION_COOKIE = "switchgate_shell_session"
const SESSION_TTL_SECONDS = 24 * 60 * 60

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url")
}

function encodeSession(session, secret) {
  const payload = Buffer.from(JSON.stringify({ exp: session.expiresAt })).toString("base64url")
  return `${payload}.${sign(payload, secret)}`
}

function decodeSession(token, secret) {
  if (!token || !secret) return null
  const [payload, signature] = String(token).split(".")
  if (!payload || !signature) return null
  const expected = Buffer.from(sign(payload, secret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return null
  }
  const expiresAt = Number(parsed?.exp)
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return null
  return { expiresAt }
}

function cookieValue(cookieHeader) {
  for (const item of String(cookieHeader || "").split(";")) {
    const trimmed = item.trim()
    if (trimmed.startsWith(`${SESSION_COOKIE}=`)) {
      return trimmed.slice(SESSION_COOKIE.length + 1)
    }
  }
  return ""
}

function sessionCookie(token, secure) {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ")
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

function newExpiry() {
  return Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  clearSessionCookie,
  cookieValue,
  decodeSession,
  encodeSession,
  newExpiry,
  sessionCookie,
}
