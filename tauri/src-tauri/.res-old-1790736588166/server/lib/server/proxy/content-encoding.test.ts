import assert from "node:assert/strict"
import test from "node:test"
import {
  gzipSync,
  zstdCompressSync,
} from "node:zlib"

import { ProxyBodyTooLargeError } from "./body-size-limit"
import { decompressRequestBody } from "./content-encoding"

const ONE_MIB = 1024 * 1024

test("gzip 解压在输出超过预算时中止", () => {
  const compressed = gzipSync(Buffer.alloc(ONE_MIB * 2))

  assert.throws(
    () => decompressRequestBody("gzip", compressed, ONE_MIB),
    ProxyBodyTooLargeError,
  )
})

test("zstd 解压在输出超过预算时中止", () => {
  const compressed = zstdCompressSync(Buffer.alloc(ONE_MIB * 2))

  assert.throws(
    () => decompressRequestBody("zstd", compressed, ONE_MIB),
    ProxyBodyTooLargeError,
  )
})

test("堆叠压缩的每一级输出都受同一预算限制", () => {
  const gzipped = gzipSync(Buffer.alloc(ONE_MIB * 2))
  const stacked = zstdCompressSync(gzipped)

  assert.throws(
    () => decompressRequestBody("gzip, zstd", stacked, ONE_MIB),
    ProxyBodyTooLargeError,
  )
})

test("解压结果恰好等于预算时允许通过", () => {
  const payload = Buffer.alloc(ONE_MIB, 7)
  const compressed = gzipSync(payload)
  const decoded = decompressRequestBody("gzip", compressed, ONE_MIB)

  assert.deepEqual(decoded, payload)
})
