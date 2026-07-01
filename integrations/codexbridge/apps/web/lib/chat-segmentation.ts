export type AssistantStreamingSegments = {
  committed: string[];
  draft: string | null;
};

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function isFenceLine(line: string): boolean {
  return /^(```|~~~)/u.test(line.trim());
}

function splitOversizedParagraph(block: string, maxChars = 360): string[] {
  const trimmed = block.trim();
  if (!trimmed || trimmed.length <= maxChars) {
    return trimmed ? [trimmed] : [];
  }
  if (trimmed.includes('\n') || isFenceLine(trimmed)) {
    return [trimmed];
  }

  const sentences = trimmed
    .split(/(?<=[。！？!?\.])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (sentences.length <= 1) {
    return [trimmed];
  }

  const segments: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (current && next.length > maxChars) {
      segments.push(current);
      current = sentence;
      continue;
    }
    current = next;
  }
  if (current) {
    segments.push(current);
  }
  return segments.length > 0 ? segments : [trimmed];
}

function collectAssistantBlocks(text: string): {
  blocks: string[];
  endsAtBoundary: boolean;
  hasOpenFence: boolean;
} {
  const normalized = normalizeText(text);
  if (!normalized) {
    return {
      blocks: [],
      endsAtBoundary: false,
      hasOpenFence: false,
    };
  }

  const lines = normalized.split('\n');
  const rawBlocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    const block = current.join('\n').trim();
    current = [];
    if (block) {
      rawBlocks.push(block);
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (isFenceLine(line)) {
      current.push(line);
      inFence = !inFence;
      continue;
    }

    if (!inFence && trimmed === '') {
      flush();
      continue;
    }

    current.push(line);
  }
  flush();

  const blocks = rawBlocks.flatMap((block) => splitOversizedParagraph(block));
  return {
    blocks,
    endsAtBoundary: /\n\s*\n\s*$/u.test(text) || /(```|~~~)\s*$/u.test(normalized),
    hasOpenFence: inFence,
  };
}

export function segmentAssistantText(text: string): string[] {
  return collectAssistantBlocks(text).blocks;
}

export function segmentAssistantStreamingText(text: string): AssistantStreamingSegments {
  const { blocks, endsAtBoundary, hasOpenFence } = collectAssistantBlocks(text);
  if (blocks.length === 0) {
    return {
      committed: [],
      draft: null,
    };
  }
  if (hasOpenFence || !endsAtBoundary) {
    if (blocks.length === 1) {
      return {
        committed: [],
        draft: blocks[0],
      };
    }
    return {
      committed: blocks.slice(0, -1),
      draft: blocks[blocks.length - 1] ?? null,
    };
  }
  return {
    committed: blocks,
    draft: null,
  };
}
