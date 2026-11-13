"use strict"

const crypto = require("node:crypto")

const PASSWORD_MIN_LENGTH = 8

function scrypt(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex")
}

function createPasswordRecord(password) {
  if (String(password || "").length < PASSWORD_MIN_LENGTH) {
    throw new Error(`登录密码至少 ${PASSWORD_MIN_LENGTH} 位`)
  }
  const salt = crypto.randomBytes(16).toString("hex")
  return { salt, hash: scrypt(password, salt) }
}

function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash) return false
  const expected = Buffer.from(String(record.hash), "hex")
  const actual = Buffer.from(scrypt(String(password || ""), record.salt), "hex")
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  createPasswordRecord,
  verifyPassword,
}
