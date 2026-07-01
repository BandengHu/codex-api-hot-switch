import type {
  CodexProviderRelayToolStrategy,
} from './types.js';
import {
  defaultCodexProviderRelayBuiltinRelayToolName,
  normalizeCodexProviderRelayBuiltinToolName,
  type CodexProviderRelayBuiltinToolName,
} from './builtin-tools/index.js';

export type CodexProviderRelayHostedToolName =
  | CodexProviderRelayBuiltinToolName
  | 'web_search_preview'
  | 'web_search_preview_2025_03_11'
  | 'computer_use'
  | 'computer_use_preview'
  | `custom:${string}`;

export type CodexProviderRelayHostedToolMode =
  | 'provider-native'
  | 'relay-emulated';

export interface CodexProviderRelayHostedToolDeclaration {
  name: CodexProviderRelayHostedToolName;
  mode: CodexProviderRelayHostedToolMode;
  providerToolName?: string | null;
  relayToolName?: string | null;
  description?: string | null;
}

export interface NormalizedCodexProviderRelayHostedToolDeclaration {
  name: CodexProviderRelayHostedToolName;
  mode: CodexProviderRelayHostedToolMode;
  providerToolName: string | null;
  relayToolName: string | null;
  description: string | null;
}

export function normalizeCodexProviderRelayHostedTools(
  declarations: CodexProviderRelayHostedToolDeclaration[] | null | undefined,
): NormalizedCodexProviderRelayHostedToolDeclaration[] {
  if (!Array.isArray(declarations)) {
    return [];
  }
  return declarations.map((declaration) => normalizeHostedToolDeclaration(declaration));
}

export function assertHostedToolDeclarationsForStrategy(
  toolStrategy: CodexProviderRelayToolStrategy,
  hostedTools: NormalizedCodexProviderRelayHostedToolDeclaration[],
): void {
  if (toolStrategy === 'codex-local-first') {
    return;
  }
  if (hostedTools.length === 0) {
    throw new Error(`${toolStrategy} requires at least one explicit hosted tool declaration.`);
  }
  for (const hostedTool of hostedTools) {
    if (hostedTool.mode !== toolStrategy) {
      throw new Error(`Hosted tool ${hostedTool.name} declares ${hostedTool.mode}, but profile strategy is ${toolStrategy}.`);
    }
  }
}

function normalizeHostedToolDeclaration(
  declaration: CodexProviderRelayHostedToolDeclaration,
): NormalizedCodexProviderRelayHostedToolDeclaration {
  if (!declaration || typeof declaration !== 'object') {
    throw new Error('Hosted tool declaration must be an object.');
  }
  const name = normalizeHostedToolName(declaration.name);
  const mode = normalizeHostedToolMode(declaration.mode);
  const providerToolName = normalizeString(declaration.providerToolName) || (mode === 'provider-native' ? name : '');
  const relayToolName = normalizeString(declaration.relayToolName)
    || (mode === 'relay-emulated' ? defaultHostedRelayToolName(name) : '');
  return {
    name,
    mode,
    providerToolName: providerToolName || null,
    relayToolName: relayToolName || null,
    description: normalizeString(declaration.description) || null,
  };
}

function normalizeHostedToolName(name: unknown): CodexProviderRelayHostedToolName {
  const normalized = normalizeString(name);
  const builtinName = normalizeCodexProviderRelayBuiltinToolName(normalized);
  if (builtinName) {
    return builtinName;
  }
  if (/^custom:[A-Za-z0-9_.-]+$/u.test(normalized)) {
    return normalized as `custom:${string}`;
  }
  throw new Error(`Unsupported hosted tool name: ${String(name)}`);
}

function defaultHostedRelayToolName(name: CodexProviderRelayHostedToolName): string {
  return name.startsWith('custom:')
    ? name.slice('custom:'.length)
    : defaultCodexProviderRelayBuiltinRelayToolName(name);
}

function normalizeHostedToolMode(mode: unknown): CodexProviderRelayHostedToolMode {
  if (mode === 'provider-native' || mode === 'relay-emulated') {
    return mode;
  }
  throw new Error(`Unsupported hosted tool mode: ${String(mode)}`);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
