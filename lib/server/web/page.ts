import {
  executeBrowsePage as executeLegacyBrowsePage,
  normalizeBrowsePageInput as normalizeLegacyBrowsePageInput,
} from "../../../scripts/web-search-mcp/page-reader.cjs"
import { readPageCache, writePageCache } from "./cache"
import { throwIfAborted } from "./errors"
import type { BrowsePageResponse } from "./types"

export async function browseWebPages(
  input: unknown,
  signal?: AbortSignal,
): Promise<BrowsePageResponse> {
  throwIfAborted(signal)
  const normalized = normalizeLegacyBrowsePageInput(input) as {
    urls: string[]
    format: string
    maxCharacters: number
    timeoutSeconds: number
  }
  const key = JSON.stringify(normalized)
  const cached = readPageCache<BrowsePageResponse>(key)
  if (cached) return cached
  const response = await executeLegacyBrowsePage(normalized, signal)
  const result = response as BrowsePageResponse
  writePageCache(key, result)
  return result
}
