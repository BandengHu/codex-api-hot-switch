export type JsonRecord = Record<string, any>;

export type CodexProviderRelayBuiltinToolName =
  | 'web_search'
  | 'file_search'
  | 'tool_search'
  | 'mcp'
  | 'skill'
  | 'shell'
  | 'local_shell'
  | 'computer'
  | 'code_interpreter'
  | 'image_generation'
  | 'apply_patch';

export type CodexProviderRelayBuiltinToolRelayMode =
  | 'provider-native'
  | 'relay-emulated'
  | 'codex-local-first'
  | 'declaration-only';

export interface CodexProviderRelayBuiltinToolDefinition {
  name: CodexProviderRelayBuiltinToolName;
  openaiToolTypes: string[];
  relayModes: CodexProviderRelayBuiltinToolRelayMode[];
  relayEmulatedSupported: boolean;
  providerNativeSupported: boolean;
  requiresExecutor: boolean;
  unsafeByDefault: boolean;
  defaultRelayToolName: string;
  description: string;
  parameters: JsonRecord;
  status: 'supported' | 'partial' | 'planned' | 'local-first';
}
