import "server-only"

import { canonicalJson } from "./json-canonical"
import {
  planChatToolOutputMedia,
  TOOL_RESULT_MEDIA_ATTACHED_MARKER,
} from "./chat-tool-media"

type AnyRecord = Record<string, any>

export type NativeToolMediaPart =
  | { type: "image"; url: string }
  | { type: "file"; fileData: string; filename?: string }

export interface NativeToolOutputMediaPlan {
  outputText: string
  contentParts: Array<{ type: "text"; text: string } | NativeToolMediaPart>
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function chatMediaPartToNative(part: AnyRecord): NativeToolMediaPart | undefined {
  if (part.type === "image_url") {
    const url =
      typeof part.image_url === "string"
        ? part.image_url
        : isObject(part.image_url)
          ? part.image_url.url
          : undefined
    return typeof url === "string" && url.trim()
      ? { type: "image", url: url.trim() }
      : undefined
  }

  if (part.type === "file" && isObject(part.file)) {
    const fileData =
      typeof part.file.file_data === "string"
        ? part.file.file_data
        : typeof part.file.file_id === "string"
          ? part.file.file_id
          : ""
    if (!fileData) return undefined
    const filename =
      typeof part.file.filename === "string" && part.file.filename.trim()
        ? part.file.filename.trim()
        : undefined
    return {
      type: "file",
      fileData,
      ...(filename ? { filename } : {}),
    }
  }

  if (part.type === "input_audio" && isObject(part.input_audio)) {
    const data =
      typeof part.input_audio.data === "string"
        ? part.input_audio.data.trim()
        : ""
    if (!data) return undefined
    const format = String(part.input_audio.format || "wav").trim().toLowerCase()
    const mimeType =
      format === "mp3" || format === "mpeg"
        ? "audio/mpeg"
        : format === "m4a"
          ? "audio/mp4"
          : `audio/${format || "wav"}`
    return {
      type: "file",
      fileData: `data:${mimeType};base64,${data}`,
    }
  }

  return undefined
}

function appendSanitizedText(value: unknown, output: string[]) {
  if (typeof value === "string") {
    if (value) output.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const part of value) {
      if (typeof part === "string") {
        if (part) output.push(part)
        continue
      }
      if (
        isObject(part) &&
        ["text", "input_text", "output_text"].includes(String(part.type || "")) &&
        typeof part.text === "string"
      ) {
        if (part.text) output.push(part.text)
        continue
      }
      output.push(canonicalJson(part))
    }
    return
  }
  if (
    isObject(value) &&
    ["text", "input_text", "output_text"].includes(String(value.type || "")) &&
    typeof value.text === "string"
  ) {
    if (value.text) output.push(value.text)
    return
  }
  output.push(canonicalJson(value))
}

export function planNativeToolOutputMedia(
  output: unknown,
): NativeToolOutputMediaPlan | undefined {
  const plan = planChatToolOutputMedia(output, TOOL_RESULT_MEDIA_ATTACHED_MARKER)
  if (!plan) return undefined

  const mediaParts = plan.mediaParts
    .map(chatMediaPartToNative)
    .filter((part): part is NativeToolMediaPart => Boolean(part))
  if (mediaParts.length === 0) return undefined

  const textParts: string[] = []
  appendSanitizedText(plan.outputValue, textParts)
  return {
    outputText: textParts.join("\n"),
    contentParts: [
      ...textParts.map((text) => ({ type: "text" as const, text })),
      ...mediaParts,
    ],
  }
}
