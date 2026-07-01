import type {
  CodexProviderRelayHostedToolExecutionRequest,
  CodexProviderRelayHostedToolExecutionResult,
  CodexProviderRelayHostedToolExecutor,
  JsonRecord,
} from './hosted_tool_executors.js';

export interface CodexProviderRelayComputerExecutorOptions {
  execute: CodexProviderRelayComputerProvider;
}

export type CodexProviderRelayComputerAction =
  | { type: 'click'; x: number; y: number; button?: string | null }
  | { type: 'double_click'; x: number; y: number }
  | { type: 'scroll'; x?: number | null; y?: number | null; scroll_x?: number | null; scroll_y?: number | null }
  | { type: 'type'; text: string }
  | { type: 'wait'; ms?: number | null }
  | { type: 'keypress'; keys: string[] }
  | { type: 'drag'; path: Array<{ x: number; y: number }> }
  | { type: 'move'; x: number; y: number }
  | { type: 'screenshot' };

export interface CodexProviderRelayComputerDisplay {
  width?: number | null;
  height?: number | null;
  environment?: string | null;
}

export interface CodexProviderRelayComputerRequest {
  actions: CodexProviderRelayComputerAction[];
  display: CodexProviderRelayComputerDisplay | null;
  toolRequest: CodexProviderRelayHostedToolExecutionRequest;
}

export interface CodexProviderRelayComputerScreenshot {
  image_url?: string | null;
  b64_png?: string | null;
  detail?: 'low' | 'high' | 'original' | null;
}

export interface CodexProviderRelayComputerExecutionResult {
  screenshot?: CodexProviderRelayComputerScreenshot | null;
  observations?: string[] | null;
  metadata?: JsonRecord | null;
}

export interface CodexProviderRelayComputerExecutorContent {
  screenshot?: CodexProviderRelayComputerScreenshot | null;
  observations: string[];
  executed_at: string;
}

export type CodexProviderRelayComputerProvider = (
  request: CodexProviderRelayComputerRequest,
) => CodexProviderRelayComputerExecutionResult | Promise<CodexProviderRelayComputerExecutionResult>;

export function createCodexProviderRelayComputerExecutor(
  options: CodexProviderRelayComputerExecutorOptions,
): CodexProviderRelayHostedToolExecutor {
  if (typeof options?.execute !== 'function') {
    throw new Error('computer executor requires an explicit sandboxed computer provider.');
  }
  return async (
    request: CodexProviderRelayHostedToolExecutionRequest,
  ): Promise<CodexProviderRelayHostedToolExecutionResult> => {
    const normalizedRequest = normalizeComputerRequest(request);
    if (normalizedRequest.actions.length === 0) {
      throw new Error('computer executor requires at least one valid action.');
    }
    const result = normalizeComputerExecutionResult(await options.execute(normalizedRequest));
    return {
      content: {
        screenshot: result.screenshot ?? undefined,
        observations: result.observations,
        executed_at: new Date().toISOString(),
      } satisfies CodexProviderRelayComputerExecutorContent,
      metadata: {
        actionCount: normalizedRequest.actions.length,
        observationCount: result.observations.length,
        hasScreenshot: Boolean(result.screenshot),
        ...(result.metadata && typeof result.metadata === 'object' ? result.metadata : {}),
      },
    };
  };
}

function normalizeComputerRequest(
  request: CodexProviderRelayHostedToolExecutionRequest,
): CodexProviderRelayComputerRequest {
  const args = request.arguments ?? {};
  return {
    actions: normalizeComputerActions(args.actions ?? args.action ?? args),
    display: normalizeComputerDisplay(args.display),
    toolRequest: request,
  };
}

function normalizeComputerActions(value: unknown): CodexProviderRelayComputerAction[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map(normalizeComputerAction)
    .filter(Boolean) as CodexProviderRelayComputerAction[];
}

function normalizeComputerAction(value: unknown): CodexProviderRelayComputerAction | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as JsonRecord;
  const type = normalizeString(record.type);
  switch (type) {
    case 'click': {
      const point = normalizePoint(record);
      return point ? {
        type,
        ...point,
        button: normalizeString(record.button) || undefined,
      } : null;
    }
    case 'double_click':
    case 'move': {
      const point = normalizePoint(record);
      return point ? { type, ...point } as CodexProviderRelayComputerAction : null;
    }
    case 'scroll': {
      return {
        type,
        x: normalizeFiniteNumber(record.x),
        y: normalizeFiniteNumber(record.y),
        scroll_x: normalizeFiniteNumber(record.scroll_x ?? record.scrollX),
        scroll_y: normalizeFiniteNumber(record.scroll_y ?? record.scrollY),
      };
    }
    case 'type': {
      const text = typeof record.text === 'string' ? record.text : '';
      return text ? { type, text } : null;
    }
    case 'wait':
      return {
        type,
        ms: normalizeNonNegativeInteger(record.ms),
      };
    case 'keypress': {
      const keys = Array.isArray(record.keys)
        ? record.keys.map(normalizeString).filter(Boolean)
        : [];
      return keys.length > 0 ? { type, keys } : null;
    }
    case 'drag': {
      const path = Array.isArray(record.path)
        ? record.path.map(normalizePoint).filter(Boolean) as Array<{ x: number; y: number }>
        : [];
      return path.length > 0 ? { type, path } : null;
    }
    case 'screenshot':
      return { type };
    default:
      return null;
  }
}

function normalizeComputerDisplay(value: unknown): CodexProviderRelayComputerDisplay | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as JsonRecord;
  const display = {
    width: normalizeFiniteNumber(record.width),
    height: normalizeFiniteNumber(record.height),
    environment: normalizeString(record.environment) || undefined,
  };
  return display.width !== null || display.height !== null || display.environment
    ? display
    : null;
}

function normalizeComputerExecutionResult(value: unknown): Required<Pick<CodexProviderRelayComputerExecutionResult, 'screenshot' | 'observations' | 'metadata'>> {
  if (!value || typeof value !== 'object') {
    return {
      screenshot: null,
      observations: [],
      metadata: null,
    };
  }
  const record = value as JsonRecord;
  return {
    screenshot: normalizeComputerScreenshot(record.screenshot),
    observations: Array.isArray(record.observations)
      ? record.observations.map(normalizeString).filter(Boolean)
      : [],
    metadata: record.metadata && typeof record.metadata === 'object'
      ? record.metadata
      : null,
  };
}

function normalizeComputerScreenshot(value: unknown): CodexProviderRelayComputerScreenshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as JsonRecord;
  const imageUrl = normalizeString(record.image_url ?? record.imageUrl ?? record.url);
  const b64Png = normalizeString(record.b64_png ?? record.b64Png ?? record.b64_data ?? record.b64Data);
  if (!imageUrl && !b64Png) {
    return null;
  }
  return {
    image_url: imageUrl || undefined,
    b64_png: b64Png || undefined,
    detail: normalizeScreenshotDetail(record.detail) || undefined,
  };
}

function normalizeScreenshotDetail(value: unknown): 'low' | 'high' | 'original' | null {
  const normalized = normalizeString(value);
  if (normalized === 'low' || normalized === 'high' || normalized === 'original') {
    return normalized;
  }
  return null;
}

function normalizePoint(value: JsonRecord): { x: number; y: number } | null {
  const x = normalizeFiniteNumber(value.x);
  const y = normalizeFiniteNumber(value.y);
  return x !== null && y !== null ? { x, y } : null;
}

function normalizeFiniteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
