import type {
  CodexProviderRelayHostedToolExecutionRequest,
  CodexProviderRelayHostedToolExecutionResult,
  CodexProviderRelayHostedToolExecutor,
  JsonRecord,
} from './hosted_tool_executors.js';

export interface CodexProviderRelayImageGenerationExecutorOptions {
  generate: CodexProviderRelayImageGenerationProvider;
}

export interface CodexProviderRelayOpenAICompatibleImageGenerationProviderOptions {
  apiKey: string;
  model?: string | null;
  endpoint?: string | null;
  fetchImpl?: typeof fetch;
}

export interface CodexProviderRelayImageGenerationRequest {
  prompt: string;
  size?: string | null;
  quality?: string | null;
  background?: string | null;
  output_format?: string | null;
  n?: number | null;
  toolRequest: CodexProviderRelayHostedToolExecutionRequest;
}

export interface CodexProviderRelayImageGenerationResult {
  b64_json?: string | null;
  url?: string | null;
  mime_type?: string | null;
  revised_prompt?: string | null;
}

export interface CodexProviderRelayImageGenerationExecutorContent {
  prompt: string;
  size?: string | null;
  quality?: string | null;
  background?: string | null;
  output_format?: string | null;
  n?: number | null;
  images: CodexProviderRelayImageGenerationResult[];
  generated_at: string;
}

export type CodexProviderRelayImageGenerationProvider = (
  request: CodexProviderRelayImageGenerationRequest,
) => CodexProviderRelayImageGenerationResult[] | Promise<CodexProviderRelayImageGenerationResult[]>;

const DEFAULT_OPENAI_COMPATIBLE_IMAGE_ENDPOINT = 'https://api.openai.com/v1/images/generations';

export function createCodexProviderRelayImageGenerationExecutor(
  options: CodexProviderRelayImageGenerationExecutorOptions,
): CodexProviderRelayHostedToolExecutor {
  if (typeof options?.generate !== 'function') {
    throw new Error('image_generation executor requires an explicit image generation provider.');
  }
  return async (
    request: CodexProviderRelayHostedToolExecutionRequest,
  ): Promise<CodexProviderRelayHostedToolExecutionResult> => {
    const normalizedRequest = normalizeImageGenerationRequest(request);
    if (!normalizedRequest.prompt) {
      throw new Error('image_generation executor requires a non-empty prompt argument.');
    }
    const images = normalizeImageGenerationResults(await options.generate(normalizedRequest));
    return {
      content: {
        prompt: normalizedRequest.prompt,
        size: normalizedRequest.size ?? null,
        quality: normalizedRequest.quality ?? null,
        background: normalizedRequest.background ?? null,
        output_format: normalizedRequest.output_format ?? null,
        n: normalizedRequest.n ?? null,
        images,
        generated_at: new Date().toISOString(),
      } satisfies CodexProviderRelayImageGenerationExecutorContent,
      metadata: {
        imageCount: images.length,
        outputFormat: normalizedRequest.output_format ?? null,
      },
    };
  };
}

export function createCodexProviderRelayOpenAICompatibleImageGenerationProvider(
  options: CodexProviderRelayOpenAICompatibleImageGenerationProviderOptions,
): CodexProviderRelayImageGenerationProvider {
  const apiKey = normalizeString(options.apiKey);
  if (!apiKey) {
    throw new Error('OpenAI-compatible image generation provider requires an API key.');
  }
  const endpoint = normalizeString(options.endpoint) || DEFAULT_OPENAI_COMPATIBLE_IMAGE_ENDPOINT;
  const model = normalizeString(options.model);
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (request) => {
    const body = omitUndefined({
      model: model || undefined,
      prompt: request.prompt,
      size: request.size || undefined,
      quality: request.quality || undefined,
      background: request.background || undefined,
      output_format: request.output_format || undefined,
      n: request.n ?? undefined,
    });
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`image_generation upstream returned HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    let payload: JsonRecord;
    try {
      const parsed = JSON.parse(text);
      payload = parsed && typeof parsed === 'object' ? parsed as JsonRecord : {};
    } catch (error) {
      throw new Error(`image_generation upstream returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return normalizeImageGenerationResults(payload.data);
  };
}

function normalizeImageGenerationRequest(
  request: CodexProviderRelayHostedToolExecutionRequest,
): CodexProviderRelayImageGenerationRequest {
  const args = request.arguments ?? {};
  const outputFormat = normalizeString(args.output_format ?? args.outputFormat);
  return {
    prompt: firstNonEmptyString([args.prompt, args.input, args.query]),
    size: normalizeString(args.size) || null,
    quality: normalizeString(args.quality) || null,
    background: normalizeString(args.background) || null,
    output_format: outputFormat || null,
    n: normalizePositiveInteger(args.n),
    toolRequest: request,
  };
}

function normalizeImageGenerationResults(value: unknown): CodexProviderRelayImageGenerationResult[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeImageGenerationResult)
    .filter(Boolean) as CodexProviderRelayImageGenerationResult[];
}

function normalizeImageGenerationResult(value: unknown): CodexProviderRelayImageGenerationResult | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as JsonRecord;
  const b64Json = normalizeString(record.b64_json ?? record.b64Json);
  const url = normalizeString(record.url);
  if (!b64Json && !url) {
    return null;
  }
  const outputFormat = normalizeString(record.output_format ?? record.outputFormat);
  return omitUndefined({
    b64_json: b64Json || undefined,
    url: url || undefined,
    mime_type: normalizeString(record.mime_type ?? record.mimeType)
      || mimeTypeFromOutputFormat(outputFormat)
      || undefined,
    revised_prompt: normalizeString(record.revised_prompt ?? record.revisedPrompt) || undefined,
  });
}

function mimeTypeFromOutputFormat(value: string): string {
  const normalized = value.toLowerCase().replace(/^\./u, '');
  if (normalized === 'jpg' || normalized === 'jpeg') {
    return 'image/jpeg';
  }
  if (normalized === 'png') {
    return 'image/png';
  }
  if (normalized === 'webp') {
    return 'image/webp';
  }
  return '';
}

function firstNonEmptyString(values: unknown[]): string {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePositiveInteger(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 10) {
    return null;
  }
  return number;
}

function omitUndefined<T extends JsonRecord>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as T;
}
