export type {
  BridgeSession,
  PlatformScopeRef,
  SessionSettings,
  ThreadMetadata,
} from '../types/core.js';

export type {
  InboundTextEvent,
  PlatformDeliveryRequest,
  PlatformPluginContract,
} from '../types/platform.js';

export type {
  ProviderProfile,
  ProviderPluginContract,
  ProviderThreadListResult,
  ProviderThreadStartResult,
  ProviderThreadSummary,
  ProviderThreadTurn,
  ProviderThreadTurnItem,
  ProviderTurnResult,
} from '../types/provider.js';

export type {
  PlatformBinding,
} from '../types/repository.js';

export const PLATFORM_IDS = Object.freeze({
  TELEGRAM: 'telegram',
  WEIXIN: 'weixin',
});

export const PROVIDER_KINDS = Object.freeze({
  OPENAI_NATIVE: 'openai-native',
  OPENAI_COMPATIBLE: 'openai-compatible',
});

export function formatPlatformScopeKey(platform: string, externalScopeId: string): string {
  return `${platform}:${externalScopeId}`;
}
