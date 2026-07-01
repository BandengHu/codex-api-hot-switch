// Ported from Codex++ protocol_proxy.rs at commit 1df4152.
// Keeps Codex Responses tool identity reversible across Chat Completions providers.

import {
  APPLY_PATCH_TOOL_NAME,
  type CodexPatchProxyAction,
  buildApplyPatchProxyTools,
  isApplyPatchToolDefinition,
  patchProxyActionFromName,
} from './apply_patch_proxy.js';

export type JsonRecord = Record<string, any>;

export type CodexCustomToolKind = 'raw' | 'apply_patch' | 'built_in';

export interface CodexCustomToolSpec {
  openaiName: string;
  kind: CodexCustomToolKind;
  proxyAction: CodexPatchProxyAction | null;
}

export interface CodexFunctionToolSpec {
  namespace: string;
  name: string;
}

export interface CodexToolContext {
  customTools: Map<string, CodexCustomToolSpec>;
  functionTools: Map<string, CodexFunctionToolSpec>;
  hasCustomTools: boolean;
  hasNamespaceTools: boolean;
}

export function createEmptyCodexToolContext(): CodexToolContext {
  return {
    customTools: new Map(),
    functionTools: new Map(),
    hasCustomTools: false,
    hasNamespaceTools: false,
  };
}

export function buildCodexToolContext(tools: unknown): CodexToolContext {
  const context = createEmptyCodexToolContext();
  if (!Array.isArray(tools)) {
    return context;
  }

  for (const tool of tools) {
    if (typeof tool === 'string' && tool.trim()) {
      const name = tool.trim();
      const proxyAction = patchProxyActionFromName(name);
      context.customTools.set(name, {
        openaiName: proxyAction ? APPLY_PATCH_TOOL_NAME : name,
        kind: proxyAction ? 'apply_patch' : 'raw',
        proxyAction,
      });
      context.hasCustomTools = true;
      continue;
    }

    if (!tool || typeof tool !== 'object') {
      continue;
    }
    const record = tool as JsonRecord;
    const type = stringValue(record.type);
    switch (type) {
      case 'custom':
        addCustomToolToContext(context, record);
        break;
      case 'function':
        addFunctionToolToContext(context, record);
        break;
      case 'namespace':
        addNamespaceToolsToContext(context, record);
        break;
      case 'web_search':
      case 'web_search_preview':
      case 'web_search_preview_2025_03_11':
      case 'local_shell':
      case 'computer_use':
        addBuiltInToolToContext(context, record, type);
        break;
      default:
        break;
    }
  }

  return context;
}

export function isCustomToolProxy(context: CodexToolContext, upstreamName: string): boolean {
  return context.customTools.has(upstreamName);
}

export function originalCustomToolName(context: CodexToolContext, upstreamName: string): string {
  return context.customTools.get(upstreamName)?.openaiName ?? upstreamName;
}

export function customToolSpec(context: CodexToolContext, upstreamName: string): CodexCustomToolSpec | null {
  return context.customTools.get(upstreamName) ?? null;
}

export function openaiNameForFunctionTool(
  context: CodexToolContext,
  upstreamName: string,
): { name: string; namespace: string } {
  const spec = context.functionTools.get(upstreamName);
  if (!spec) {
    return { name: upstreamName, namespace: '' };
  }
  return {
    name: spec.name || upstreamName,
    namespace: spec.namespace,
  };
}

export function responsesToolsToChatTools(
  tools: unknown,
  context: CodexToolContext,
  options: {
    shortenToolName: (name: string) => string;
    builtinToolConverter?: ((tool: JsonRecord) => JsonRecord | null) | null;
  },
): JsonRecord[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const converted: JsonRecord[] = [];
  for (const tool of tools) {
    if (typeof tool === 'string' && tool.trim()) {
      converted.push(genericCustomProxyTool(options.shortenToolName(tool.trim()), ''));
      continue;
    }
    if (!tool || typeof tool !== 'object') {
      continue;
    }
    const record = tool as JsonRecord;
    const type = stringValue(record.type);
    switch (type) {
      case 'function': {
        const chatTool = responsesFunctionToolToChatTool(record, options.shortenToolName);
        if (chatTool) {
          converted.push(chatTool);
        }
        break;
      }
      case 'custom':
      case 'web_search':
      case 'web_search_preview':
      case 'web_search_preview_2025_03_11':
      case 'local_shell':
      case 'computer_use': {
        if (isHostedWebSearchToolType(type) && options.builtinToolConverter) {
          const builtin = options.builtinToolConverter(record);
          if (builtin) {
            converted.push(builtin);
          }
          break;
        }
        const name = stringValue(record.name) || type;
        const description = stringValue(record.description);
        if (isApplyPatchToolDefinition(record, name)) {
          converted.push(...buildApplyPatchProxyTools(name, description));
        } else {
          converted.push(genericCustomProxyTool(options.shortenToolName(name), description));
        }
        break;
      }
      case 'namespace':
        converted.push(...namespaceToolToChatTools(record, context, options.shortenToolName));
        break;
      default:
        break;
    }
  }
  return converted;
}

export function flattenNamespaceToolName(namespace: string, name: string): string {
  return namespace ? `${namespace}${name}` : name;
}

function addCustomToolToContext(context: CodexToolContext, tool: JsonRecord): void {
  const name = stringValue(tool.name);
  if (!name) {
    return;
  }
  const kind = detectCodexCustomToolKind(tool, name);
  context.customTools.set(name, {
    openaiName: name,
    kind,
    proxyAction: null,
  });
  if (kind === 'apply_patch') {
    for (const proxy of buildApplyPatchProxyTools(name)) {
      const proxyName = stringValue(proxy.function?.name);
      const proxyAction = patchProxyActionFromName(proxyName, name);
      if (proxyName && proxyAction) {
        context.customTools.set(proxyName, {
          openaiName: name,
          kind: 'apply_patch',
          proxyAction,
        });
      }
    }
  }
  context.hasCustomTools = true;
}

function addFunctionToolToContext(context: CodexToolContext, tool: JsonRecord): void {
  const name = stringValue(tool.name);
  if (!name) {
    return;
  }
  context.functionTools.set(name, {
    name,
    namespace: '',
  });
}

function addNamespaceToolsToContext(context: CodexToolContext, namespaceTool: JsonRecord): void {
  const namespace = stringValue(namespaceTool.name);
  const children = Array.isArray(namespaceTool.tools) ? namespaceTool.tools : [];
  for (const child of children) {
    if (!child || typeof child !== 'object' || stringValue((child as JsonRecord).type) !== 'function') {
      continue;
    }
    const name = stringValue((child as JsonRecord).name);
    if (!name) {
      continue;
    }
    const flat = flattenNamespaceToolName(namespace, name);
    const existing = context.functionTools.get(flat);
    if (!namespace || !existing || existing.namespace) {
      context.functionTools.set(flat, {
        namespace,
        name,
      });
      if (namespace) {
        context.hasNamespaceTools = true;
      }
    }
  }
}

function addBuiltInToolToContext(context: CodexToolContext, tool: JsonRecord, type: string): void {
  const name = stringValue(tool.name) || type;
  context.customTools.set(name, {
    openaiName: name,
    kind: 'built_in',
    proxyAction: null,
  });
  context.hasCustomTools = true;
}

function detectCodexCustomToolKind(tool: JsonRecord, name: string): CodexCustomToolKind {
  if (isApplyPatchToolDefinition(tool, name)) {
    return 'apply_patch';
  }
  const type = stringValue(tool.type);
  if (isHostedWebSearchToolType(type) || ['local_shell', 'computer_use'].includes(type)) {
    return 'built_in';
  }
  return 'raw';
}

function isHostedWebSearchToolType(type: string): boolean {
  return type === 'web_search'
    || type === 'web_search_preview'
    || type === 'web_search_preview_2025_03_11';
}

function responsesFunctionToolToChatTool(
  tool: JsonRecord,
  shortenToolName: (name: string) => string,
): JsonRecord | null {
  if (stringValue(tool.type) !== 'function') {
    return null;
  }
  if (tool.function && typeof tool.function === 'object') {
    const chatTool = cloneJson(tool);
    const functionRecord = chatTool.function as JsonRecord;
    functionRecord.name = shortenToolName(stringValue(functionRecord.name) || stringValue(tool.name));
    functionRecord.parameters = normalizeChatToolParameters(functionRecord.parameters);
    if (tool.strict !== undefined && functionRecord.strict === undefined) {
      functionRecord.strict = tool.strict;
    }
    delete chatTool.strict;
    return chatTool;
  }

  const name = shortenToolName(stringValue(tool.name));
  if (!name) {
    return null;
  }
  return {
    type: 'function',
    function: omitUndefined({
      name,
      description: stringValue(tool.description) || undefined,
      parameters: normalizeChatToolParameters(tool.parameters),
      strict: tool.strict,
    }),
  };
}

function namespaceToolToChatTools(
  namespaceTool: JsonRecord,
  context: CodexToolContext,
  shortenToolName: (name: string) => string,
): JsonRecord[] {
  const namespace = stringValue(namespaceTool.name);
  const namespaceDescription = stringValue(namespaceTool.description);
  const children = Array.isArray(namespaceTool.tools) ? namespaceTool.tools : [];
  const converted: JsonRecord[] = [];

  for (const child of children) {
    if (!child || typeof child !== 'object' || stringValue((child as JsonRecord).type) !== 'function') {
      continue;
    }
    const childRecord = child as JsonRecord;
    const name = stringValue(childRecord.name);
    if (!name) {
      continue;
    }
    const flat = flattenNamespaceToolName(namespace, name);
    if (
      namespace
      && context.functionTools.get(flat)?.namespace === ''
    ) {
      continue;
    }
    converted.push({
      type: 'function',
      function: omitUndefined({
        name: shortenToolName(flat),
        description: combineNamespaceDescription(namespaceDescription, stringValue(childRecord.description)),
        parameters: normalizeChatToolParameters(childRecord.parameters),
        strict: childRecord.strict,
      }),
    });
  }

  return converted;
}

function genericCustomProxyTool(name: string, description: string): JsonRecord {
  return {
    type: 'function',
    function: omitUndefined({
      name,
      description: description || undefined,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          input: { type: 'string' },
        },
        required: ['input'],
      },
    }),
  };
}

function combineNamespaceDescription(namespaceDescription: string, childDescription: string): string | undefined {
  if (namespaceDescription && childDescription) {
    return `${namespaceDescription}\n\n${childDescription}`;
  }
  return namespaceDescription || childDescription || undefined;
}

function normalizeChatToolParameters(parameters: unknown): JsonRecord {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return { type: 'object', properties: {}, required: [] };
  }
  const normalized = cloneJson(parameters as JsonRecord);
  if (!stringValue(normalized.type)) {
    normalized.type = 'object';
  }
  if (!normalized.properties || typeof normalized.properties !== 'object' || Array.isArray(normalized.properties)) {
    normalized.properties = {};
  }
  if (!Array.isArray(normalized.required)) {
    normalized.required = [];
  }
  return normalized;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function omitUndefined<T extends JsonRecord>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) {
      delete record[key];
    }
  }
  return record;
}
