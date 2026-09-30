import {
  buildCodexProviderRelayCliArgs,
  buildCodexProviderRelayConfig,
  codexBaseUrlForRelayProtocol,
  normalizeProviderLabel,
  normalizeRelayBaseUrl,
} from './codex_config.js';
import {
  assertHostedToolDeclarationsForStrategy,
  normalizeCodexProviderRelayHostedTools,
  type CodexProviderRelayHostedToolDeclaration,
  type NormalizedCodexProviderRelayHostedToolDeclaration,
} from './hosted_tools.js';
import type {
  BuildCodexProviderRelayConfigInput,
  CodexProviderRelayAuthMode,
  CodexProviderRelayConfig,
  CodexProviderRelayProtocol,
  CodexProviderRelayTomlPrimitive,
  CodexProviderRelayToolStrategy,
} from './types.js';

export type CodexProviderRelayProfileMode =
  | 'official'
  | 'mixed'
  | 'pure-api';

export interface BuildCodexProviderRelayProfileInput {
  mode: CodexProviderRelayProfileMode;
  providerLabel: string;
  upstreamBaseUrl: string;
  defaultModel: string;
  providerName?: string | null;
  protocolProxyPort?: number | null;
  experimentalBearerToken?: string | null;
  apiKeyEnv?: string | null;
  supportsWebsockets?: boolean | null;
  toolStrategy?: CodexProviderRelayToolStrategy | null;
  hostedTools?: CodexProviderRelayHostedToolDeclaration[] | null;
  extraProviderFields?: Record<string, CodexProviderRelayTomlPrimitive | null | undefined> | null;
}

export interface CodexProviderRelayProfile {
  mode: CodexProviderRelayProfileMode;
  providerLabel: string;
  providerName: string;
  upstreamBaseUrl: string;
  codexBaseUrl: string;
  relayProtocol: CodexProviderRelayProtocol;
  authMode: CodexProviderRelayAuthMode;
  toolStrategy: CodexProviderRelayToolStrategy;
  hostedTools: NormalizedCodexProviderRelayHostedToolDeclaration[];
  needsLocalResponsesAdapter: boolean;
  configInput: BuildCodexProviderRelayConfigInput;
  config: CodexProviderRelayConfig;
  codexCliArgs: string[];
}

export function buildCodexProviderRelayProfile(
  input: BuildCodexProviderRelayProfileInput,
): CodexProviderRelayProfile {
  const mode = normalizeProfileMode(input.mode);
  const relayProtocol = defaultProtocolForProfileMode(mode);
  const authMode = authModeForProfileMode(mode);
  const toolStrategy = input.toolStrategy ?? 'codex-local-first';
  const hostedTools = normalizeCodexProviderRelayHostedTools(input.hostedTools);
  assertHostedToolDeclarationsForStrategy(toolStrategy, hostedTools);
  const providerLabel = normalizeProviderLabel(input.providerLabel);
  const upstreamBaseUrl = normalizeRelayBaseUrl(input.upstreamBaseUrl);
  const defaultModel = normalizeString(input.defaultModel);
  if (!defaultModel) {
    throw new Error('Codex provider relay profile requires a default model.');
  }
  const configInput: BuildCodexProviderRelayConfigInput = {
    providerLabel,
    providerName: input.providerName ?? defaultProviderNameForProfileMode(mode),
    relayBaseUrl: upstreamBaseUrl,
    relayProtocol,
    protocolProxyPort: input.protocolProxyPort ?? null,
    defaultModel,
    authMode,
    experimentalBearerToken: input.experimentalBearerToken ?? null,
    apiKeyEnv: input.apiKeyEnv ?? null,
    supportsWebsockets: input.supportsWebsockets ?? null,
    toolStrategy,
    extraProviderFields: input.extraProviderFields ?? null,
  };
  const config = buildCodexProviderRelayConfig(configInput);
  return {
    mode,
    providerLabel: config.providerLabel,
    providerName: config.providerName,
    upstreamBaseUrl: config.upstreamBaseUrl,
    codexBaseUrl: config.codexBaseUrl,
    relayProtocol: config.relayProtocol,
    authMode: config.authMode,
    toolStrategy: config.toolStrategy,
    hostedTools,
    needsLocalResponsesAdapter: config.codexBaseUrl !== config.upstreamBaseUrl,
    configInput,
    config,
    codexCliArgs: buildCodexProviderRelayCliArgs(configInput),
  };
}

export function defaultProtocolForProfileMode(
  mode: CodexProviderRelayProfileMode,
): CodexProviderRelayProtocol {
  switch (mode) {
    case 'official':
      return 'responses';
    case 'mixed':
    case 'pure-api':
      return 'chat-completions';
    default:
      assertNeverProfileMode(mode);
  }
}

export function authModeForProfileMode(
  mode: CodexProviderRelayProfileMode,
): CodexProviderRelayAuthMode {
  switch (mode) {
    case 'official':
    case 'mixed':
      return 'codex-auth-compatible';
    case 'pure-api':
      return 'api-key-compatible';
    default:
      assertNeverProfileMode(mode);
  }
}

export function codexBaseUrlForProfile(input: {
  mode: CodexProviderRelayProfileMode;
  upstreamBaseUrl: string;
  protocolProxyPort?: number | null;
}): string {
  return codexBaseUrlForRelayProtocol({
    relayBaseUrl: input.upstreamBaseUrl,
    relayProtocol: defaultProtocolForProfileMode(input.mode),
    protocolProxyPort: input.protocolProxyPort,
  });
}

function defaultProviderNameForProfileMode(mode: CodexProviderRelayProfileMode): string {
  switch (mode) {
    case 'official':
      return 'Official Responses Provider';
    case 'mixed':
      return 'Mixed Codex Relay Provider';
    case 'pure-api':
      return 'Pure API Relay Provider';
    default:
      assertNeverProfileMode(mode);
  }
}

function normalizeProfileMode(mode: CodexProviderRelayProfileMode): CodexProviderRelayProfileMode {
  if (mode === 'official' || mode === 'mixed' || mode === 'pure-api') {
    return mode;
  }
  throw new Error(`Unsupported Codex provider relay profile mode: ${String(mode)}`);
}

function assertNeverProfileMode(mode: never): never {
  throw new Error(`Unsupported Codex provider relay profile mode: ${String(mode)}`);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
