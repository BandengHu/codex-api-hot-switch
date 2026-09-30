import type {
  BuildCodexProviderRelayConfigInput,
  CodexProviderRelayAuthMode,
  CodexProviderRelayConfig,
  CodexProviderRelayConfigEntry,
  CodexProviderRelayProtocol,
  CodexProviderRelayTomlPrimitive,
  CodexProviderRelayToolStrategy,
} from './types.js';

const DEFAULT_AUTH_MODE: CodexProviderRelayAuthMode = 'codex-auth-compatible';
const DEFAULT_RELAY_PROTOCOL: CodexProviderRelayProtocol = 'responses';
const DEFAULT_TOOL_STRATEGY: CodexProviderRelayToolStrategy = 'codex-local-first';
const DEFAULT_PROVIDER_NAME = 'Codex Provider Relay';
const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY';
export const DEFAULT_CODEX_PROVIDER_RELAY_PROTOCOL_PROXY_PORT = 57321;

export function buildCodexProviderRelayConfig(
  input: BuildCodexProviderRelayConfigInput,
): CodexProviderRelayConfig {
  const providerLabel = normalizeProviderLabel(input.providerLabel);
  const providerName = normalizeString(input.providerName) || DEFAULT_PROVIDER_NAME;
  const upstreamBaseUrl = normalizeRelayBaseUrl(input.relayBaseUrl);
  const relayProtocol = input.relayProtocol ?? DEFAULT_RELAY_PROTOCOL;
  const protocolProxyPort = normalizeProtocolProxyPort(input.protocolProxyPort);
  const codexBaseUrl = codexBaseUrlForRelayProtocol({
    relayBaseUrl: upstreamBaseUrl,
    relayProtocol,
    protocolProxyPort,
  });
  const defaultModel = normalizeString(input.defaultModel);
  if (!defaultModel) {
    throw new Error('Codex provider relay config requires a default model.');
  }

  const authMode = input.authMode ?? DEFAULT_AUTH_MODE;
  const toolStrategy = input.toolStrategy ?? DEFAULT_TOOL_STRATEGY;
  const supportsWebsockets = Boolean(input.supportsWebsockets ?? false);
  const entries: CodexProviderRelayConfigEntry[] = [
    { key: 'model', value: defaultModel },
    { key: 'model_provider', value: providerLabel },
    { key: `model_providers.${providerLabel}.name`, value: providerName },
    { key: `model_providers.${providerLabel}.base_url`, value: codexBaseUrl },
    { key: `model_providers.${providerLabel}.wire_api`, value: 'responses' },
    {
      key: `model_providers.${providerLabel}.requires_openai_auth`,
      value: authMode === 'codex-auth-compatible',
    },
    {
      key: `model_providers.${providerLabel}.supports_websockets`,
      value: supportsWebsockets,
    },
  ];

  appendTokenEntries(entries, providerLabel, authMode, input);
  appendExtraProviderFields(entries, providerLabel, input.extraProviderFields);

  return {
    providerLabel,
    providerName,
    authMode,
    relayProtocol,
    upstreamBaseUrl,
    codexBaseUrl,
    protocolProxyPort,
    toolStrategy,
    entries,
  };
}

export function buildCodexProviderRelayCliArgs(
  input: BuildCodexProviderRelayConfigInput,
): string[] {
  const config = buildCodexProviderRelayConfig(input);
  return config.entries.flatMap((entry) => [
    '-c',
    `${entry.key}=${tomlValue(entry.value)}`,
  ]);
}

export function buildCodexProviderRelayTomlFragment(
  input: BuildCodexProviderRelayConfigInput,
): string {
  const config = buildCodexProviderRelayConfig(input);
  const rootEntries = config.entries.filter((entry) => !entry.key.startsWith('model_providers.'));
  const providerPrefix = `model_providers.${config.providerLabel}.`;
  const providerEntries = config.entries
    .filter((entry) => entry.key.startsWith(providerPrefix))
    .map((entry) => ({
      key: entry.key.slice(providerPrefix.length),
      value: entry.value,
    }));

  const lines = [
    ...rootEntries.map((entry) => `${entry.key} = ${tomlValue(entry.value)}`),
    '',
    `[model_providers.${config.providerLabel}]`,
    ...providerEntries.map((entry) => `${entry.key} = ${tomlValue(entry.value)}`),
  ];
  return `${lines.join('\n')}\n`;
}

export function normalizeProviderLabel(value: string): string {
  const normalized = normalizeString(value)
    .replace(/[^A-Za-z0-9_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  if (!normalized) {
    throw new Error('Codex provider relay config requires a provider label.');
  }
  if (/^\d/u.test(normalized)) {
    return `provider_${normalized}`;
  }
  return normalized;
}

export function normalizeRelayBaseUrl(value: string): string {
  const normalized = normalizeString(value).replace(/\/+$/u, '');
  if (!normalized) {
    throw new Error('Codex provider relay config requires a relay base URL.');
  }
  return normalized;
}

export function localResponsesProxyBaseUrl(
  port = DEFAULT_CODEX_PROVIDER_RELAY_PROTOCOL_PROXY_PORT,
): string {
  return `http://127.0.0.1:${normalizeProtocolProxyPort(port)}/v1`;
}

export function codexBaseUrlForRelayProtocol(input: {
  relayBaseUrl: string;
  relayProtocol?: CodexProviderRelayProtocol | null;
  protocolProxyPort?: number | null;
}): string {
  const relayProtocol = input.relayProtocol ?? DEFAULT_RELAY_PROTOCOL;
  if (relayProtocol === 'responses') {
    return normalizeRelayBaseUrl(input.relayBaseUrl);
  }
  if (relayProtocol === 'chat-completions') {
    return localResponsesProxyBaseUrl(input.protocolProxyPort ?? undefined);
  }
  throw new Error(`Unsupported Codex provider relay protocol: ${String(relayProtocol)}`);
}

export function tomlValue(value: CodexProviderRelayTomlPrimitive): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('TOML numeric values must be finite.');
    }
    return String(value);
  }
  return tomlString(value);
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}

function appendTokenEntries(
  entries: CodexProviderRelayConfigEntry[],
  providerLabel: string,
  authMode: CodexProviderRelayAuthMode,
  input: BuildCodexProviderRelayConfigInput,
) {
  const experimentalBearerToken = normalizeString(input.experimentalBearerToken);
  const apiKeyEnv = normalizeString(input.apiKeyEnv);
  if (experimentalBearerToken) {
    entries.push({
      key: `model_providers.${providerLabel}.experimental_bearer_token`,
      value: experimentalBearerToken,
    });
    return;
  }
  const envKey = apiKeyEnv || (authMode === 'api-key-compatible' ? DEFAULT_API_KEY_ENV : '');
  if (envKey) {
    entries.push({
      key: `model_providers.${providerLabel}.env_key`,
      value: envKey,
    });
  }
}

function appendExtraProviderFields(
  entries: CodexProviderRelayConfigEntry[],
  providerLabel: string,
  fields: BuildCodexProviderRelayConfigInput['extraProviderFields'],
) {
  if (!fields) {
    return;
  }
  for (const [rawKey, value] of Object.entries(fields)) {
    if (value === null || value === undefined) {
      continue;
    }
    const key = normalizeProviderFieldKey(rawKey);
    entries.push({
      key: `model_providers.${providerLabel}.${key}`,
      value,
    });
  }
}

function normalizeProviderFieldKey(value: string): string {
  const key = normalizeString(value);
  if (!/^[A-Za-z0-9_.-]+$/u.test(key)) {
    throw new Error(`Invalid Codex provider config field: ${value}`);
  }
  return key;
}

function normalizeProtocolProxyPort(value: number | null | undefined): number {
  if (value === null || value === undefined) {
    return DEFAULT_CODEX_PROVIDER_RELAY_PROTOCOL_PROXY_PORT;
  }
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('Codex provider relay protocol proxy port must be an integer from 1 to 65535.');
  }
  return value;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
