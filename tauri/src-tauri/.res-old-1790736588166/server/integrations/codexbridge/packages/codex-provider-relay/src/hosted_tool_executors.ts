import type {
  CodexProviderRelayHostedToolName,
} from './hosted_tools.js';
import {
  normalizeCodexProviderRelayBuiltinToolName,
} from './builtin-tools/index.js';

export type JsonRecord = Record<string, any>;

export interface CodexProviderRelayHostedToolExecutionRequest {
  toolName: CodexProviderRelayHostedToolName;
  relayToolName: string;
  callId: string;
  arguments: JsonRecord;
  rawArguments: string;
  model: string | null;
  providerKind: string | null;
  providerName: string | null;
  emitDelta?: CodexProviderRelayHostedToolDeltaEmitter | null;
}

export interface CodexProviderRelayHostedToolExecutionResult {
  content: unknown;
  metadata?: JsonRecord | null;
}

export type CodexProviderRelayHostedToolDeltaEmitter = (
  delta: unknown,
  metadata?: JsonRecord | null,
) => void | Promise<void>;

export type CodexProviderRelayHostedToolExecutor = (
  request: CodexProviderRelayHostedToolExecutionRequest,
) => CodexProviderRelayHostedToolExecutionResult | Promise<CodexProviderRelayHostedToolExecutionResult>;

export interface CodexProviderRelayHostedToolExecutorRegistration {
  toolName: CodexProviderRelayHostedToolName;
  executor: CodexProviderRelayHostedToolExecutor;
}

export type CodexProviderRelayHostedToolExecutorRegistryInput =
  | CodexProviderRelayHostedToolExecutorRegistry
  | CodexProviderRelayHostedToolExecutorRegistration[]
  | Record<string, CodexProviderRelayHostedToolExecutor>
  | null
  | undefined;

export class CodexProviderRelayHostedToolExecutorRegistry {
  private readonly executors = new Map<string, CodexProviderRelayHostedToolExecutor>();

  register(
    toolName: CodexProviderRelayHostedToolName,
    executor: CodexProviderRelayHostedToolExecutor,
  ): this {
    const normalizedName = normalizeHostedToolExecutorName(toolName);
    if (!normalizedName) {
      throw new Error(`Invalid hosted tool executor name: ${String(toolName)}`);
    }
    if (typeof executor !== 'function') {
      throw new Error(`Hosted tool executor for ${normalizedName} must be a function.`);
    }
    this.executors.set(normalizedName, executor);
    return this;
  }

  has(toolName: CodexProviderRelayHostedToolName): boolean {
    return this.executors.has(normalizeHostedToolExecutorName(toolName));
  }

  get(toolName: CodexProviderRelayHostedToolName): CodexProviderRelayHostedToolExecutor | null {
    return this.executors.get(normalizeHostedToolExecutorName(toolName)) ?? null;
  }

  async execute(
    request: CodexProviderRelayHostedToolExecutionRequest,
  ): Promise<CodexProviderRelayHostedToolExecutionResult> {
    const executor = this.get(request.toolName);
    if (!executor) {
      throw new Error(`No hosted tool executor registered for ${request.toolName}.`);
    }
    return normalizeHostedToolExecutionResult(await executor(request));
  }
}

export function createCodexProviderRelayHostedToolExecutorRegistry(
  input: CodexProviderRelayHostedToolExecutorRegistryInput = null,
): CodexProviderRelayHostedToolExecutorRegistry {
  if (input instanceof CodexProviderRelayHostedToolExecutorRegistry) {
    return input;
  }
  const registry = new CodexProviderRelayHostedToolExecutorRegistry();
  if (!input) {
    return registry;
  }
  if (Array.isArray(input)) {
    for (const registration of input) {
      registry.register(registration.toolName, registration.executor);
    }
    return registry;
  }
  if (typeof input === 'object') {
    for (const [toolName, executor] of Object.entries(input)) {
      registry.register(toolName as CodexProviderRelayHostedToolName, executor);
    }
  }
  return registry;
}

export function formatCodexProviderRelayHostedToolExecutionResult(
  result: CodexProviderRelayHostedToolExecutionResult,
): string {
  const normalized = normalizeHostedToolExecutionResult(result);
  if (typeof normalized.content === 'string') {
    return normalized.content;
  }
  return JSON.stringify({
    content: normalized.content ?? null,
    metadata: normalized.metadata ?? undefined,
  });
}

function normalizeHostedToolExecutionResult(value: unknown): CodexProviderRelayHostedToolExecutionResult {
  if (value && typeof value === 'object' && 'content' in (value as JsonRecord)) {
    const record = value as JsonRecord;
    return {
      content: record.content,
      metadata: record.metadata && typeof record.metadata === 'object'
        ? record.metadata
        : null,
    };
  }
  return {
    content: value ?? null,
    metadata: null,
  };
}

function normalizeHostedToolExecutorName(value: unknown): CodexProviderRelayHostedToolName {
  const raw = String(value ?? '').trim();
  return (normalizeCodexProviderRelayBuiltinToolName(raw) ?? raw) as CodexProviderRelayHostedToolName;
}
