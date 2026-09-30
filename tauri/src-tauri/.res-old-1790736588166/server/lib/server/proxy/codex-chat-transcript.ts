import "server-only"

import { createHash } from "node:crypto"

const EMPTY_TRANSCRIPT_HASH = createHash("sha256")
  .update("")
  .digest("base64url")

export interface TranscriptNode {
  previous?: TranscriptNode
  items: unknown[]
  itemCount: number
  sequenceHash: string
  byteSize: number
  responseRefs: number
  childRefs: number
}

function cloneJson<T>(value: T): T {
  return structuredClone(value) as T
}

function serializedItem(item: unknown) {
  try {
    return JSON.stringify(item) ?? "null"
  } catch {
    return String(item)
  }
}

function extendSequenceHash(previousHash: string, serialized: string) {
  return createHash("sha256")
    .update(previousHash)
    .update("\0")
    .update(serialized)
    .digest("base64url")
}

export function transcriptIndexKey(itemCount: number, sequenceHash: string) {
  return `${itemCount}:${sequenceHash}`
}

export function transcriptPrefixIndexKeys(items: unknown[]) {
  let sequenceHash = EMPTY_TRANSCRIPT_HASH
  return items.map((item, index) => {
    sequenceHash = extendSequenceHash(sequenceHash, serializedItem(item))
    return transcriptIndexKey(index + 1, sequenceHash)
  })
}

export class CodexChatTranscriptStore {
  private storedBytes = 0
  private storedNodeCount = 0

  get bytes() {
    return this.storedBytes
  }

  get nodeCount() {
    return this.storedNodeCount
  }

  createNode(previous: TranscriptNode | undefined, items: unknown[]) {
    let sequenceHash = previous?.sequenceHash ?? EMPTY_TRANSCRIPT_HASH
    let byteSize = 0
    for (const item of items) {
      const serialized = serializedItem(item)
      byteSize += Buffer.byteLength(serialized, "utf8")
      sequenceHash = extendSequenceHash(sequenceHash, serialized)
    }

    const node: TranscriptNode = {
      previous,
      items,
      itemCount: (previous?.itemCount ?? 0) + items.length,
      sequenceHash,
      byteSize,
      responseRefs: 0,
      childRefs: 0,
    }
    if (previous) previous.childRefs += 1
    this.storedBytes += byteSize
    this.storedNodeCount += 1
    return node
  }

  materialize(tail: TranscriptNode) {
    const nodes: TranscriptNode[] = []
    for (let node: TranscriptNode | undefined = tail; node; node = node.previous) {
      nodes.push(node)
    }

    const items: unknown[] = []
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      items.push(...cloneJson(nodes[index].items))
    }
    return items
  }

  release(node: TranscriptNode) {
    if (node.responseRefs > 0 || node.childRefs > 0) return
    this.storedBytes = Math.max(0, this.storedBytes - node.byteSize)
    this.storedNodeCount = Math.max(0, this.storedNodeCount - 1)
    const previous = node.previous
    if (!previous) return
    previous.childRefs = Math.max(0, previous.childRefs - 1)
    this.release(previous)
  }
}
