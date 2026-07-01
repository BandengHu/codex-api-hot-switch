import {
  CODEX_PROVIDER_RELAY_BUILTIN_TOOL_ALIASES,
  CODEX_PROVIDER_RELAY_BUILTIN_TOOL_DEFINITIONS,
} from './catalog.js';
import type {
  CodexProviderRelayBuiltinToolDefinition,
  CodexProviderRelayBuiltinToolName,
  JsonRecord,
} from './types.js';

export function normalizeCodexProviderRelayBuiltinToolName(
  value: unknown,
): CodexProviderRelayBuiltinToolName | null {
  const normalized = normalizeString(value);
  return CODEX_PROVIDER_RELAY_BUILTIN_TOOL_ALIASES[normalized] ?? null;
}

export function getCodexProviderRelayBuiltinToolDefinition(
  value: unknown,
): CodexProviderRelayBuiltinToolDefinition | null {
  const name = normalizeCodexProviderRelayBuiltinToolName(value);
  return name ? CODEX_PROVIDER_RELAY_BUILTIN_TOOL_DEFINITIONS[name] : null;
}

export function isCodexProviderRelayBuiltinToolType(value: unknown): boolean {
  return Boolean(normalizeCodexProviderRelayBuiltinToolName(value));
}

export function isCodexProviderRelayRelayEmulatedBuiltinToolType(value: unknown): boolean {
  return Boolean(getCodexProviderRelayBuiltinToolDefinition(value)?.relayEmulatedSupported);
}

export function isCodexProviderRelayProviderNativeBuiltinToolType(value: unknown): boolean {
  return Boolean(getCodexProviderRelayBuiltinToolDefinition(value)?.providerNativeSupported);
}

export function isCodexProviderRelayUnsafeBuiltinToolType(value: unknown): boolean {
  return Boolean(getCodexProviderRelayBuiltinToolDefinition(value)?.unsafeByDefault);
}

export function defaultCodexProviderRelayBuiltinToolDescription(value: unknown): string {
  return getCodexProviderRelayBuiltinToolDefinition(value)?.description
    ?? 'Execute a relay-hosted built-in tool.';
}

export function codexProviderRelayBuiltinToolParameters(value: unknown): JsonRecord {
  return getCodexProviderRelayBuiltinToolDefinition(value)?.parameters
    ?? {
      type: 'object',
      properties: {},
      additionalProperties: true,
    };
}

export function defaultCodexProviderRelayBuiltinRelayToolName(value: unknown): string {
  return getCodexProviderRelayBuiltinToolDefinition(value)?.defaultRelayToolName
    ?? normalizeString(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
