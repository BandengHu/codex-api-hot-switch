import { CodexAppClient, createStderrLogger } from '../codex/app_client.js';
import { CodexProviderPlugin } from '../codex/plugin.js';
import {
  mergeOpenAICompatibleProviderCapabilities,
  resolveReasoningEffortForProvider,
  type OpenAICompatibleProviderCapabilities,
} from '../shared/thinking_policy.js';
import type {
  ProviderModelInfo,
  ProviderProfile,
  ProviderReviewTarget,
  ProviderTurnProgress,
  ProviderTurnResult,
  ProviderUsageReport,
} from '../../types/provider.js';
import type { BridgeSession, SessionSettings } from '../../types/core.js';
import {
  buildCodexProviderRelayCliArgs,
  CodexProviderRelayRuntime,
  type CodexProviderRelayAdapterServerFactory,
  type CodexProviderRelayHostedToolDeclaration,
  type CodexProviderRelayProfileMode,
  type CodexProviderRelayToolStrategy,
} from '../../../packages/codex-provider-relay/src/index.js';

interface OpenAICompatibleProviderProfileConfig extends Record<string, unknown> {
  cliBin?: string | null;
  launchCommand?: string | null;
  autolaunch?: boolean;
  apiKeyEnv?: string | null;
  baseUrl?: string | null;
  defaultModel?: string | null;
  providerLabel?: string | null;
  modelCatalog?: ProviderModelInfo[];
  modelCatalogMode?: 'merge' | 'overlay-only';
  upstreamChatCompletionsPath?: string | null;
  ownedBy?: string | null;
  relayProfileMode?: CodexProviderRelayProfileMode | null;
  toolStrategy?: CodexProviderRelayToolStrategy | null;
  hostedTools?: CodexProviderRelayHostedToolDeclaration[] | null;
  capabilities?: OpenAICompatibleProviderCapabilities | null;
}

export type OpenAICompatibleProviderProfile = ProviderProfile & {
  config: OpenAICompatibleProviderProfileConfig;
};

export interface OpenAICompatibleProviderDefaults {
  kind?: string | null;
  displayName?: string | null;
  apiKeyEnv?: string | null;
  baseUrl?: string | null;
  defaultModel?: string | null;
  providerLabel?: string | null;
  modelIds?: string[];
  ownedBy?: string | null;
  upstreamChatCompletionsPath?: string | null;
  capabilities?: OpenAICompatibleProviderCapabilities | null;
}

export interface OpenAICompatibleProviderPluginOptions {
  clientFactory?: any;
  reviewRunner?: any;
  adapterServerFactory?: CodexProviderRelayAdapterServerFactory;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  defaults?: OpenAICompatibleProviderDefaults;
}

interface NormalizedOpenAICompatibleProviderDefaults {
  kind: string;
  displayName: string;
  apiKeyEnv: string;
  baseUrl: string;
  defaultModel: string;
  providerLabel: string;
  modelIds: string[];
  ownedBy: string;
  upstreamChatCompletionsPath: string;
  capabilities: OpenAICompatibleProviderCapabilities | null;
}

interface OpenAICompatibleCodexClientOptions {
  adapterServerFactory?: CodexProviderRelayAdapterServerFactory;
  fetchImpl: typeof fetch;
  env: NodeJS.ProcessEnv;
  defaults: NormalizedOpenAICompatibleProviderDefaults;
}

interface LiveModelCacheEntry {
  models: ProviderModelInfo[];
  fetchedAt: number;
}

const DEFAULT_PROVIDER_DEFAULTS: NormalizedOpenAICompatibleProviderDefaults = {
  kind: 'openai-compatible',
  displayName: 'OpenAI Compatible',
  apiKeyEnv: 'OPENAI_API_KEY',
  baseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-5.4',
  providerLabel: 'openai_compatible',
  modelIds: ['gpt-5.4'],
  ownedBy: 'openai-compatible',
  upstreamChatCompletionsPath: '/chat/completions',
  capabilities: {
    supportsBuiltinWebSearchTool: true,
  },
};
const LIVE_MODEL_CACHE_TTL_MS = 30_000;

export class OpenAICompatibleProviderPlugin extends CodexProviderPlugin {
  readonly defaults: NormalizedOpenAICompatibleProviderDefaults;

  private readonly fetchImpl: typeof fetch;

  private readonly env: NodeJS.ProcessEnv;

  private readonly liveModelCache: Map<string, LiveModelCacheEntry>;

  constructor(options: OpenAICompatibleProviderPluginOptions = {}) {
    const defaults = normalizeProviderDefaults(options.defaults);
    const fetchImpl = options.fetchImpl ?? fetch;
    const env = options.env ?? process.env;
    super({
      clientFactory: options.clientFactory
        ?? ((profile: OpenAICompatibleProviderProfile) => createOpenAICompatibleCodexClient(profile, {
          adapterServerFactory: options.adapterServerFactory,
          fetchImpl,
          env,
          defaults,
        })),
      reviewRunner: options.reviewRunner,
    });
    this.defaults = defaults;
    this.fetchImpl = fetchImpl;
    this.env = env;
    this.liveModelCache = new Map();
    this.kind = defaults.kind;
    this.displayName = defaults.displayName;
  }

  async listModels({
    providerProfile,
  }: {
    providerProfile: ProviderProfile;
  }): Promise<ProviderModelInfo[]> {
    const liveModels = await this.fetchLiveModels(providerProfile, { force: true });
    if (liveModels && liveModels.length > 0) {
      return liveModels;
    }
    return super.listModels({ providerProfile });
  }

  async resolveModelInfo(
    providerProfile: ProviderProfile,
    client: any,
    requestedModel: string | null,
  ): Promise<ProviderModelInfo | null> {
    const liveModels = await this.fetchLiveModels(providerProfile);
    if (liveModels && liveModels.length > 0) {
      const config = providerProfile.config as OpenAICompatibleProviderProfileConfig;
      return resolvePreferredModelFromCatalog({
        models: liveModels,
        requestedModel,
        defaultModel: normalizeString(config.defaultModel) || this.defaults.defaultModel,
      });
    }
    return super.resolveModelInfo(providerProfile, client, requestedModel);
  }

  async startReview({
    bridgeSession = null,
    target,
    cwd,
    onTurnStarted = null,
  }: {
    providerProfile: ProviderProfile;
    bridgeSession?: BridgeSession | null;
    sessionSettings: SessionSettings | null;
    cwd: string;
    target: ProviderReviewTarget;
    locale?: string | null;
    onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
    onTurnStarted?: ((meta: Record<string, unknown>) => Promise<void> | void) | null;
    onApprovalRequest?: ((request: any) => Promise<void> | void) | null;
  }): Promise<ProviderTurnResult> {
    const threadId = bridgeSession?.codexThreadId ?? `${this.kind}-review-${Date.now()}`;
    const turnId = `${threadId}-unsupported`;
    await onTurnStarted?.({
      threadId,
      turnId,
      bridgeSessionId: bridgeSession?.id ?? null,
    });
    return {
      outputText: '',
      outputState: 'failed',
      previewText: '',
      finalSource: 'provider_error',
      errorMessage: `${this.displayName} provider currently supports normal Codex turns through the local Responses adapter, but not the codex review CLI path. cwd=${cwd}; target=${target.type}`,
      turnId,
      threadId,
      status: 'failed',
      title: `${this.displayName} review unsupported`,
    };
  }

  async getUsage(): Promise<ProviderUsageReport | null> {
    return null;
  }

  resolveReasoningEffort(
    providerProfile: ProviderProfile,
    modelInfo: ProviderModelInfo | null,
    requestedEffort: string | null,
  ): string | null {
    return resolveReasoningEffortForProvider({
      providerKind: providerProfile.providerKind,
      modelInfo,
      requestedEffort,
      capabilities: this.resolveProviderCapabilities(providerProfile),
    });
  }

  private resolveProviderCapabilities(providerProfile: ProviderProfile): OpenAICompatibleProviderCapabilities | null {
    const config = providerProfile.config as OpenAICompatibleProviderProfileConfig;
    return mergeOpenAICompatibleProviderCapabilities(
      this.defaults.capabilities,
      config.capabilities,
    );
  }

  private async fetchLiveModels(
    providerProfile: ProviderProfile,
    { force = false }: { force?: boolean } = {},
  ): Promise<ProviderModelInfo[] | null> {
    const cacheKey = providerProfile.id;
    const cached = this.liveModelCache.get(cacheKey) ?? null;
    if (!force && cached && (Date.now() - cached.fetchedAt) < LIVE_MODEL_CACHE_TTL_MS) {
      return cached.models;
    }

    const config = providerProfile.config as OpenAICompatibleProviderProfileConfig;
    const envName = normalizeString(config.apiKeyEnv) || this.defaults.apiKeyEnv;
    const apiKey = normalizeString(this.env[envName]);
    const upstreamBaseUrl = normalizeString(config.baseUrl) || this.defaults.baseUrl;
    if (!apiKey || !upstreamBaseUrl) {
      return cached?.models ?? null;
    }

    try {
      const response = await this.fetchImpl(`${upstreamBaseUrl.replace(/\/+$/u, '')}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        return cached?.models ?? null;
      }
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const models = normalizeLiveModelCatalog({
        rows,
        staticCatalog: normalizeModelCatalog(
          config.modelCatalog,
          this.defaults.modelIds,
          this.resolveProviderCapabilities(providerProfile),
        ),
        defaultModel: normalizeString(config.defaultModel) || this.defaults.defaultModel,
      });
      if (models.length === 0) {
        return cached?.models ?? null;
      }
      this.liveModelCache.set(cacheKey, {
        models,
        fetchedAt: Date.now(),
      });
      return models;
    } catch {
      return cached?.models ?? null;
    }
  }
}

class OpenAICompatibleCodexClient {
  private readonly profile: OpenAICompatibleProviderProfile;

  private readonly options: OpenAICompatibleCodexClientOptions;

  private relayRuntime: CodexProviderRelayRuntime | null;

  private delegate: CodexAppClient | null;

  constructor(profile: OpenAICompatibleProviderProfile, options: OpenAICompatibleCodexClientOptions) {
    this.profile = profile;
    this.options = options;
    this.relayRuntime = null;
    this.delegate = null;
  }

  async start(): Promise<void> {
    if (this.delegate?.isConnected()) {
      return;
    }
    const config = this.profile.config;
    const apiKey = resolveApiKey(config, this.options.env, this.options.defaults.apiKeyEnv, this.options.defaults.displayName);
    const providerCapabilities = mergeOpenAICompatibleProviderCapabilities(
      this.options.defaults.capabilities,
      config.capabilities,
    );
    this.relayRuntime = new CodexProviderRelayRuntime({
      apiKey,
      upstreamBaseUrl: normalizeString(config.baseUrl) || this.options.defaults.baseUrl,
      defaultModel: normalizeString(config.defaultModel) || this.options.defaults.defaultModel,
      providerLabel: normalizeProviderLabel(config.providerLabel) || this.options.defaults.providerLabel,
      providerName: this.profile.displayName || this.options.defaults.displayName,
      profileMode: normalizeRelayProfileMode(config.relayProfileMode) ?? 'pure-api',
      authMode: 'api-key-compatible',
      apiKeyEnv: normalizeString(config.apiKeyEnv) || this.options.defaults.apiKeyEnv,
      supportsWebsockets: false,
      toolStrategy: normalizeToolStrategy(config.toolStrategy) ?? 'codex-local-first',
      hostedTools: normalizeHostedTools(config.hostedTools),
      adapterServerFactory: this.options.adapterServerFactory,
      adapterOptions: {
        fetchImpl: this.options.fetchImpl,
        models: normalizeModelCatalog(config.modelCatalog, this.options.defaults.modelIds, providerCapabilities),
        providerKind: normalizeString(this.profile.providerKind) || this.options.defaults.kind,
        providerName: this.profile.displayName || this.options.defaults.displayName,
        providerCapabilities: providerCapabilities as Record<string, unknown> | null,
        upstreamResponsesPath: providerCapabilities?.upstreamResponsesPath ?? null,
        upstreamChatCompletionsPath: normalizeString(config.upstreamChatCompletionsPath) || this.options.defaults.upstreamChatCompletionsPath,
        ownedBy: normalizeString(config.ownedBy) || this.options.defaults.ownedBy,
      },
    });
    const relayState = await this.relayRuntime.start();
    const delegate = new CodexAppClient({
      codexCliBin: normalizeString(config.cliBin) || 'codex',
      codexCliArgs: relayState.codexCliArgs,
      launchCommand: normalizeString(config.launchCommand) || null,
      autolaunch: Boolean(config.autolaunch),
      modelCatalog: Array.isArray(config.modelCatalog) ? config.modelCatalog as any : [],
      modelCatalogMode: config.modelCatalogMode ?? 'overlay-only',
      logger: createStderrLogger(),
    });
    this.delegate = delegate;
    try {
      await delegate.start();
    } catch (error) {
      const relayRuntime = this.relayRuntime;
      this.delegate = null;
      this.relayRuntime = null;
      await relayRuntime?.stop?.().catch(() => {});
      throw error;
    }
  }

  async stop(): Promise<void> {
    const delegate = this.delegate;
    const relayRuntime = this.relayRuntime;
    this.delegate = null;
    this.relayRuntime = null;
    await Promise.allSettled([
      delegate?.stop?.(),
      relayRuntime?.stop?.(),
    ]);
  }

  isConnected(): boolean {
    return Boolean(this.delegate?.isConnected?.());
  }

  currentClient(): CodexAppClient {
    if (!this.delegate) {
      throw new Error(`${this.options.defaults.displayName} Codex client has not been started.`);
    }
    return this.delegate;
  }
}

export function createOpenAICompatibleCodexClient(
  profile: OpenAICompatibleProviderProfile,
  options: OpenAICompatibleCodexClientOptions,
): any {
  const wrapper = new OpenAICompatibleCodexClient(profile, options);
  return new Proxy(wrapper, {
    get(target, property, receiver) {
      if (property in target) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const delegate = target.currentClient() as any;
      const value = delegate[property as keyof CodexAppClient];
      return typeof value === 'function' ? value.bind(delegate) : value;
    },
  });
}

export function buildOpenAICompatibleCodexCliArgs({
  providerLabel,
  providerName,
  adapterBaseUrl,
  apiKeyEnv,
  defaultModel,
}: {
  providerLabel: string;
  providerName: string;
  adapterBaseUrl: string;
  apiKeyEnv: string;
  defaultModel: string;
}): string[] {
  const label = normalizeProviderLabel(providerLabel) || DEFAULT_PROVIDER_DEFAULTS.providerLabel;
  return buildCodexProviderRelayCliArgs({
    providerLabel: label,
    providerName: normalizeString(providerName) || DEFAULT_PROVIDER_DEFAULTS.displayName,
    relayBaseUrl: adapterBaseUrl,
    relayProtocol: 'responses',
    defaultModel: normalizeString(defaultModel) || DEFAULT_PROVIDER_DEFAULTS.defaultModel,
    authMode: 'api-key-compatible',
    apiKeyEnv: normalizeString(apiKeyEnv) || DEFAULT_PROVIDER_DEFAULTS.apiKeyEnv,
    supportsWebsockets: false,
  });
}

function resolveApiKey(
  config: OpenAICompatibleProviderProfileConfig,
  env: NodeJS.ProcessEnv,
  defaultApiKeyEnv: string,
  providerName: string,
): string {
  const envName = normalizeString(config.apiKeyEnv) || defaultApiKeyEnv;
  const apiKey = normalizeString(env[envName]);
  if (!apiKey) {
    throw new Error(`${providerName} API key is missing. Set ${envName} in the service environment.`);
  }
  return apiKey;
}

function normalizeRelayProfileMode(value: unknown): CodexProviderRelayProfileMode | null {
  if (value === 'official' || value === 'mixed' || value === 'pure-api') {
    return value;
  }
  return null;
}

function normalizeToolStrategy(value: unknown): CodexProviderRelayToolStrategy | null {
  if (value === 'codex-local-first' || value === 'provider-native' || value === 'relay-emulated') {
    return value;
  }
  return null;
}

function normalizeHostedTools(value: unknown): CodexProviderRelayHostedToolDeclaration[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter((entry): entry is CodexProviderRelayHostedToolDeclaration => Boolean(entry && typeof entry === 'object'));
}

function normalizeModelCatalog(
  catalog: unknown,
  fallback: string[],
  providerCapabilities: OpenAICompatibleProviderCapabilities | null,
): Array<Record<string, unknown>> {
  const entries = Array.isArray(catalog)
    ? catalog
      .map((entry: any) => {
        const id = normalizeString(entry?.model) || normalizeString(entry?.id);
        if (!id) {
          return null;
        }
        return {
          ...entry,
          id,
          model: normalizeString(entry?.model) || id,
          capabilities: normalizeModelCapabilityForCatalog(id, entry, providerCapabilities),
        };
      })
      .filter(Boolean) as Array<Record<string, unknown>>
    : [];
  if (entries.length > 0) {
    return entries;
  }
  return fallback.map((id) => ({
    id,
    model: id,
    capabilities: normalizeModelCapabilityForCatalog(id, null, providerCapabilities),
  }));
}

function normalizeModelCapabilityForCatalog(
  id: string,
  entry: any,
  providerCapabilities: OpenAICompatibleProviderCapabilities | null,
): Record<string, unknown> | undefined {
  const catalogEntry = providerCapabilities?.modelCapabilities?.[id] ?? null;
  const explicit = entry?.capabilities && typeof entry.capabilities === 'object'
    ? entry.capabilities
    : {};
  const merged = {
    ...catalogEntry,
    ...explicit,
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeProviderDefaults(defaults: OpenAICompatibleProviderDefaults | undefined): NormalizedOpenAICompatibleProviderDefaults {
  const kind = normalizeString(defaults?.kind) || DEFAULT_PROVIDER_DEFAULTS.kind;
  return {
    kind,
    displayName: normalizeString(defaults?.displayName) || DEFAULT_PROVIDER_DEFAULTS.displayName,
    apiKeyEnv: normalizeString(defaults?.apiKeyEnv) || DEFAULT_PROVIDER_DEFAULTS.apiKeyEnv,
    baseUrl: normalizeString(defaults?.baseUrl) || DEFAULT_PROVIDER_DEFAULTS.baseUrl,
    defaultModel: normalizeString(defaults?.defaultModel) || DEFAULT_PROVIDER_DEFAULTS.defaultModel,
    providerLabel: normalizeProviderLabel(defaults?.providerLabel) || normalizeProviderLabel(kind) || DEFAULT_PROVIDER_DEFAULTS.providerLabel,
    modelIds: Array.isArray(defaults?.modelIds) && defaults?.modelIds.length > 0
      ? defaults.modelIds.map((entry) => normalizeString(entry)).filter(Boolean)
      : [...DEFAULT_PROVIDER_DEFAULTS.modelIds],
    ownedBy: normalizeString(defaults?.ownedBy) || kind,
    upstreamChatCompletionsPath: normalizeString(defaults?.upstreamChatCompletionsPath) || DEFAULT_PROVIDER_DEFAULTS.upstreamChatCompletionsPath,
    capabilities: mergeOpenAICompatibleProviderCapabilities(DEFAULT_PROVIDER_DEFAULTS.capabilities, defaults?.capabilities),
  };
}

function normalizeLiveModelCatalog({
  rows,
  staticCatalog,
  defaultModel,
}: {
  rows: unknown[];
  staticCatalog: Array<Record<string, unknown>>;
  defaultModel: string;
}): ProviderModelInfo[] {
  const staticById = new Map<string, Record<string, unknown>>();
  for (const entry of staticCatalog) {
    const id = normalizeString(entry?.id) || normalizeString(entry?.model);
    if (!id) {
      continue;
    }
    staticById.set(id.toLowerCase(), entry);
  }

  const models: ProviderModelInfo[] = [];
  const seen = new Set<string>();
  for (const rawEntry of rows) {
    const entry = rawEntry as Record<string, unknown> | null;
    const id = normalizeString(entry?.id) || normalizeString(entry?.model);
    if (!id) {
      continue;
    }
    const normalizedId = id.toLowerCase();
    if (seen.has(normalizedId)) {
      continue;
    }
    seen.add(normalizedId);
    const staticEntry = staticById.get(normalizedId) ?? null;
    models.push({
      id,
      model: normalizeString(entry?.model) || id,
      displayName: normalizeString(entry?.display_name)
        || normalizeString(entry?.displayName)
        || normalizeString(entry?.name)
        || normalizeString(staticEntry?.displayName)
        || id,
      description: normalizeString(entry?.description)
        || normalizeString(staticEntry?.description),
      isDefault: normalizeBoolean(entry?.is_default)
        ?? normalizeBoolean(entry?.isDefault)
        ?? id === defaultModel,
      supportedReasoningEfforts: normalizeStringList(staticEntry?.supportedReasoningEfforts),
      defaultReasoningEffort: normalizeString(staticEntry?.defaultReasoningEffort) || null,
    });
  }

  if (models.length === 0) {
    return [];
  }
  if (!models.some((entry) => entry.isDefault)) {
    const configuredDefault = defaultModel.toLowerCase();
    const defaultEntry = models.find((entry) => entry.id.toLowerCase() === configuredDefault)
      ?? models[0];
    if (defaultEntry) {
      defaultEntry.isDefault = true;
    }
  }
  return models;
}

function resolvePreferredModelFromCatalog({
  models,
  requestedModel,
  defaultModel,
}: {
  models: ProviderModelInfo[];
  requestedModel: string | null;
  defaultModel: string;
}): ProviderModelInfo | null {
  const requestedMatch = findModelInCatalog(models, requestedModel);
  if (requestedMatch) {
    return requestedMatch;
  }
  const configuredDefault = findModelInCatalog(models, defaultModel);
  if (configuredDefault) {
    return configuredDefault;
  }
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

function findModelInCatalog(models: ProviderModelInfo[], token: string | null): ProviderModelInfo | null {
  const normalizedToken = normalizeString(token).toLowerCase();
  if (!normalizedToken) {
    return null;
  }
  return models.find((model) => (
    normalizeString(model.id).toLowerCase() === normalizedToken
    || normalizeString(model.model).toLowerCase() === normalizedToken
    || normalizeString(model.displayName).toLowerCase() === normalizedToken
  )) ?? null;
}

function normalizeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => normalizeString(entry)).filter(Boolean)
    : [];
}

function normalizeProviderLabel(value: unknown): string {
  const normalized = normalizeString(value);
  return /^[A-Za-z0-9_]+$/u.test(normalized) ? normalized : '';
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
