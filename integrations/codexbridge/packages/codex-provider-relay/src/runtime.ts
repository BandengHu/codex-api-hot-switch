import {
  normalizeRelayBaseUrl,
} from './codex_config.js';
import {
  authModeForProfileMode,
  buildCodexProviderRelayProfile,
  type CodexProviderRelayProfile,
  type CodexProviderRelayProfileMode,
} from './profiles.js';
import type {
  CodexProviderRelayHostedToolDeclaration,
} from './hosted_tools.js';
import type {
  CodexProviderRelayHostedToolExecutorRegistryInput,
} from './hosted_tool_executors.js';
import type {
  CodexProviderRelayAuthMode,
  CodexProviderRelayConfig,
  CodexProviderRelayToolStrategy,
  CodexProviderRelayTomlPrimitive,
} from './types.js';
import {
  OpenAICompatibleResponsesAdapterServer,
  type OpenAICompatibleResponsesAdapterServerOptions,
} from './server/responses_adapter_server.js';

export interface CodexProviderRelayAdapterServer {
  readonly baseUrl: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type CodexProviderRelayAdapterServerOptions = {
  apiKey: string;
  upstreamBaseUrl: string;
  defaultModel: string;
  host?: string;
  port?: number;
} & OpenAICompatibleResponsesAdapterServerOptions & Record<string, unknown>;

export type CodexProviderRelayAdapterServerFactory = (
  options: CodexProviderRelayAdapterServerOptions,
) => CodexProviderRelayAdapterServer;

export interface CodexProviderRelayRuntimeOptions {
  apiKey: string;
  upstreamBaseUrl: string;
  defaultModel: string;
  providerLabel: string;
  providerName?: string | null;
  profileMode?: CodexProviderRelayProfileMode | null;
  authMode?: CodexProviderRelayAuthMode | null;
  experimentalBearerToken?: string | null;
  apiKeyEnv?: string | null;
  supportsWebsockets?: boolean | null;
  toolStrategy?: CodexProviderRelayToolStrategy | null;
  hostedTools?: CodexProviderRelayHostedToolDeclaration[] | null;
  hostedToolExecutors?: CodexProviderRelayHostedToolExecutorRegistryInput;
  maxHostedToolIterations?: number | null;
  emitHostedToolSseEvents?: boolean | null;
  extraProviderFields?: Record<string, CodexProviderRelayTomlPrimitive | null | undefined> | null;
  adapterHost?: string | null;
  adapterPort?: number | null;
  adapterOptions?: Record<string, unknown> | null;
  adapterServerFactory?: CodexProviderRelayAdapterServerFactory | null;
}

export interface CodexProviderRelayRuntimeState {
  adapterBaseUrl: string | null;
  codexBaseUrl: string;
  codexCliArgs: string[];
  codexConfig: CodexProviderRelayConfig;
  relayProfile: CodexProviderRelayProfile;
}

export class CodexProviderRelayRuntime {
  private readonly options: CodexProviderRelayRuntimeOptions;

  private adapterServer: CodexProviderRelayAdapterServer | null;

  private currentState: CodexProviderRelayRuntimeState | null;

  constructor(options: CodexProviderRelayRuntimeOptions) {
    this.options = options;
    this.adapterServer = null;
    this.currentState = null;
  }

  get state(): CodexProviderRelayRuntimeState | null {
    return this.currentState;
  }

  isStarted(): boolean {
    return Boolean(this.adapterServer && this.currentState);
  }

  async start(): Promise<CodexProviderRelayRuntimeState> {
    if (this.adapterServer && this.currentState) {
      return this.currentState;
    }
    const profileMode = this.resolveProfileMode();
    const apiKey = normalizeString(this.options.apiKey);
    if (profileMode !== 'official' && !apiKey) {
      throw new Error('Codex provider relay runtime requires an upstream API key.');
    }
    const upstreamBaseUrl = normalizeRelayBaseUrl(this.options.upstreamBaseUrl);
    const defaultModel = normalizeString(this.options.defaultModel);
    if (!defaultModel) {
      throw new Error('Codex provider relay runtime requires a default model.');
    }

    if (profileMode === 'official') {
      const relayProfile = this.buildRelayProfile({
        profileMode,
        upstreamBaseUrl,
        protocolProxyPort: null,
        apiKey,
        defaultModel,
      });
      const state: CodexProviderRelayRuntimeState = {
        adapterBaseUrl: null,
        codexBaseUrl: relayProfile.codexBaseUrl,
        codexCliArgs: relayProfile.codexCliArgs,
        codexConfig: relayProfile.config,
        relayProfile,
      };
      this.currentState = state;
      return state;
    }

    const adapterServerFactory = this.options.adapterServerFactory
      ?? createDefaultCodexProviderRelayAdapterServer;
    const server = adapterServerFactory({
      ...normalizeAdapterOptions(this.options.adapterOptions),
      apiKey,
      upstreamBaseUrl,
      defaultModel,
      host: normalizeString(this.options.adapterHost) || undefined,
      port: normalizePort(this.options.adapterPort),
      ...(this.options.hostedTools !== undefined ? { hostedTools: this.options.hostedTools ?? null } : {}),
      ...(this.options.hostedToolExecutors !== undefined ? { hostedToolExecutors: this.options.hostedToolExecutors ?? null } : {}),
      ...(this.options.maxHostedToolIterations !== undefined ? { maxHostedToolIterations: this.options.maxHostedToolIterations ?? null } : {}),
      ...(this.options.emitHostedToolSseEvents !== undefined ? { emitHostedToolSseEvents: this.options.emitHostedToolSseEvents ?? null } : {}),
    });
    await server.start();

    const adapterBaseUrl = normalizeRelayBaseUrl(`${server.baseUrl}/v1`);
    const protocolProxyPort = protocolProxyPortFromBaseUrl(adapterBaseUrl);
    const relayProfile = this.buildRelayProfile({
      profileMode,
      upstreamBaseUrl,
      protocolProxyPort,
      apiKey,
      defaultModel,
    });
    const state: CodexProviderRelayRuntimeState = {
      adapterBaseUrl,
      codexBaseUrl: relayProfile.codexBaseUrl,
      codexCliArgs: relayProfile.codexCliArgs,
      codexConfig: relayProfile.config,
      relayProfile,
    };

    this.adapterServer = server;
    this.currentState = state;
    return state;
  }

  async stop(): Promise<void> {
    const server = this.adapterServer;
    this.adapterServer = null;
    this.currentState = null;
    await server?.stop?.();
  }

  private buildRelayProfile({
    profileMode,
    upstreamBaseUrl,
    protocolProxyPort,
    apiKey,
    defaultModel,
  }: {
    profileMode: CodexProviderRelayProfileMode;
    upstreamBaseUrl: string;
    protocolProxyPort: number | null;
    apiKey: string;
    defaultModel: string;
  }): CodexProviderRelayProfile {
    const authMode = authModeForProfileMode(profileMode);
    return buildCodexProviderRelayProfile({
      mode: profileMode,
      providerLabel: this.options.providerLabel,
      providerName: normalizeString(this.options.providerName) || null,
      upstreamBaseUrl,
      protocolProxyPort,
      defaultModel,
      experimentalBearerToken: authMode === 'codex-auth-compatible'
        ? normalizeString(this.options.experimentalBearerToken) || apiKey || null
        : normalizeString(this.options.experimentalBearerToken) || null,
      apiKeyEnv: normalizeString(this.options.apiKeyEnv) || null,
      supportsWebsockets: this.options.supportsWebsockets ?? false,
      toolStrategy: this.options.toolStrategy ?? 'codex-local-first',
      hostedTools: this.options.hostedTools ?? null,
      extraProviderFields: this.options.extraProviderFields ?? null,
    });
  }

  private resolveProfileMode(): CodexProviderRelayProfileMode {
    return this.options.profileMode
      ?? profileModeForAuthMode(this.options.authMode ?? 'codex-auth-compatible');
  }
}

function profileModeForAuthMode(authMode: CodexProviderRelayAuthMode): CodexProviderRelayProfileMode {
  return authMode === 'api-key-compatible' ? 'pure-api' : 'mixed';
}

function normalizePort(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error('Codex provider relay adapter port must be an integer from 0 to 65535.');
  }
  return value;
}

function protocolProxyPortFromBaseUrl(baseUrl: string): number | null {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.port) {
      return Number(parsed.port);
    }
    if (parsed.protocol === 'http:') {
      return 80;
    }
    if (parsed.protocol === 'https:') {
      return 443;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeAdapterOptions(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function createDefaultCodexProviderRelayAdapterServer(
  options: CodexProviderRelayAdapterServerOptions,
): CodexProviderRelayAdapterServer {
  return new OpenAICompatibleResponsesAdapterServer(options);
}
