import "server-only"

export interface SseFrameBoundary {
  index: number
  separatorLength: 2 | 4
}

export function lastCompleteSseFrameBoundary(text: string): SseFrameBoundary | null {
  const crlf = text.lastIndexOf("\r\n\r\n")
  const lf = text.lastIndexOf("\n\n")
  if (crlf < 0 && lf < 0) return null
  if (crlf >= 0 && crlf >= lf) return { index: crlf, separatorLength: 4 }
  return { index: lf, separatorLength: 2 }
}
