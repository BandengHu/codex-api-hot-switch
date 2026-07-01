import "server-only"

import { NextResponse } from "next/server"

export function jsonError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status })
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export async function readJsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T
  } catch {
    throw new Error("请求体不是有效的 JSON")
  }
}
