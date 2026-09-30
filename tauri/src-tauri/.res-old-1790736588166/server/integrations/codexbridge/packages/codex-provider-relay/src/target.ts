export const CODEX_PROVIDER_TARGET =
  'Let non-OpenAI models participate in the Codex native tool-call loop.' as const;

export const CODEX_PROVIDER_TARGET_ZH =
  '让非 OpenAI 模型也能参与 Codex 的原生工具调用闭环。' as const;

export const CODEX_PROVIDER_PACKAGE_NAME = '@codex-provider/core' as const;

export const LEGACY_CODEX_PROVIDER_RELAY_PACKAGE_NAME = '@codexbridge/codex-provider-relay' as const;

export const CODEX_PROVIDER_PACKAGE_PHASE = 'phase-1-public-api-rename-aliases' as const;

export const CODEX_PROVIDER_RELEASE_CHANNEL = 'internal-only' as const;

export const CODEX_PROVIDER_OWNS = [
  'codex-provider-config',
  'relay-profile-presets',
  'responses-to-chat-conversion',
  'chat-to-responses-conversion',
  'sse-stream-conversion',
  'tool-call-conversion',
  'usage-normalization',
  'error-normalization',
  'multimodal-policy',
  'reasoning-thinking-policy',
  'provider-capabilities',
  'payload-rules',
  'local-responses-adapter-server',
  'hosted-tool-contract',
] as const;

export const CODEX_PROVIDER_DOES_NOT_OWN = [
  'codex-native-api',
  'wechat-transport',
  'telegram-transport',
  'slash-commands',
  'i18n',
  'sendgate',
  'bridge-sessions',
  'thread-binding',
  'approvals',
  'retry-reconnect',
  'assistant-records',
  'automations',
  'uploads',
  'artifact-delivery-policy',
] as const;

export type CodexProviderOwnedResponsibility = typeof CODEX_PROVIDER_OWNS[number];

export type CodexProviderExcludedResponsibility = typeof CODEX_PROVIDER_DOES_NOT_OWN[number];

export const CODEX_PROVIDER_INVARIANTS = [
  'Codex app-server remains the owner of threads, approvals, local tools, workspace mutations, and continuation.',
  'The relay preserves Codex Responses API semantics and translates provider tool calls back into Codex-compatible events.',
  'Hosted tool support must be explicit: provider-native or relay-emulated, never silently assumed.',
  'Host-app UI/session/platform state must stay outside this package.',
  'codex-native-api remains a separate package with a separate responsibility.',
] as const;

export const CODEX_PROVIDER_NON_GOALS = [
  'Merge codex-native-api into the provider relay.',
  'Move host-app session stores or platform adapters into the relay package.',
  'Treat every upstream provider as if it supports OpenAI hosted tools.',
  'Hardcode host-app-specific runtime state.',
] as const;

/**
 * @deprecated Use CODEX_PROVIDER_TARGET.
 */
export const CODEX_PROVIDER_RELAY_TARGET = CODEX_PROVIDER_TARGET;

/**
 * @deprecated Use CODEX_PROVIDER_TARGET_ZH.
 */
export const CODEX_PROVIDER_RELAY_TARGET_ZH = CODEX_PROVIDER_TARGET_ZH;

/**
 * @deprecated Use CODEX_PROVIDER_PACKAGE_NAME.
 */
export const CODEX_PROVIDER_RELAY_PACKAGE_NAME = CODEX_PROVIDER_PACKAGE_NAME;

/**
 * @deprecated Use CODEX_PROVIDER_PACKAGE_PHASE.
 */
export const CODEX_PROVIDER_RELAY_PACKAGE_PHASE = CODEX_PROVIDER_PACKAGE_PHASE;

/**
 * @deprecated Use CODEX_PROVIDER_RELEASE_CHANNEL.
 */
export const CODEX_PROVIDER_RELAY_RELEASE_CHANNEL = CODEX_PROVIDER_RELEASE_CHANNEL;

/**
 * @deprecated Use CODEX_PROVIDER_OWNS.
 */
export const CODEX_PROVIDER_RELAY_OWNS = CODEX_PROVIDER_OWNS;

/**
 * @deprecated Use CODEX_PROVIDER_DOES_NOT_OWN.
 */
export const CODEX_PROVIDER_RELAY_DOES_NOT_OWN = CODEX_PROVIDER_DOES_NOT_OWN;

/**
 * @deprecated Use CodexProviderOwnedResponsibility.
 */
export type CodexProviderRelayOwnedResponsibility = CodexProviderOwnedResponsibility;

/**
 * @deprecated Use CodexProviderExcludedResponsibility.
 */
export type CodexProviderRelayExcludedResponsibility = CodexProviderExcludedResponsibility;

/**
 * @deprecated Use CODEX_PROVIDER_INVARIANTS.
 */
export const CODEX_PROVIDER_RELAY_INVARIANTS = CODEX_PROVIDER_INVARIANTS;

/**
 * @deprecated Use CODEX_PROVIDER_NON_GOALS.
 */
export const CODEX_PROVIDER_RELAY_NON_GOALS = CODEX_PROVIDER_NON_GOALS;
