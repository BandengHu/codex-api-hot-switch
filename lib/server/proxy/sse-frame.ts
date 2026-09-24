import "server-only"

export interface SseFrameBoundary {
  index: number
  separatorLength: 2 | 4
}

/**
 * 单帧上限。
 *
 * 正常上游一帧也就几 KB，只有畸形或恶意上游才会吐出没有换行分隔的长串。没有上限时
 * `buffer` 会一直吃字节直到进程 OOM——这层保护是为了把那种情况变成一次可读的报错。
 * 上限取 1MB：比任何正常帧都宽，同时远小于会把进程撑爆的量级。
 */
export const MAX_SSE_FRAME_LENGTH = 1_000_000

export class SseFrameTooLargeError extends Error {
  constructor(length: number, limit = MAX_SSE_FRAME_LENGTH) {
    super(`上游 SSE 单帧超过上限：${length} 字节 > ${limit} 字节`)
    this.name = "SseFrameTooLargeError"
  }
}

/** 缓冲里还没成帧的残留超过上限就抛错，交给各流的错误分支去收尾。 */
export function assertSseBufferWithinLimit(buffer: string) {
  if (buffer.length > MAX_SSE_FRAME_LENGTH) {
    throw new SseFrameTooLargeError(buffer.length)
  }
  return buffer
}

export function lastCompleteSseFrameBoundary(text: string): SseFrameBoundary | null {
  const crlf = text.lastIndexOf("\r\n\r\n")
  const lf = text.lastIndexOf("\n\n")
  if (crlf < 0 && lf < 0) return null
  if (crlf >= 0 && crlf >= lf) return { index: crlf, separatorLength: 4 }
  return { index: lf, separatorLength: 2 }
}
