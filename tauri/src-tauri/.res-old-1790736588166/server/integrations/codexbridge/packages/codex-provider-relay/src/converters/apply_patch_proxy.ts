// Ported from Codex++ protocol_proxy.rs at commit 1df4152.
// Converts Codex freeform apply_patch custom-tool input to structured Chat tool calls
// and reconstructs Codex-compatible patch text from structured proxy arguments.

type JsonRecord = Record<string, any>;

export const APPLY_PATCH_TOOL_NAME = 'apply_patch' as const;

export type CodexPatchProxyAction =
  | 'add_file'
  | 'delete_file'
  | 'update_file'
  | 'replace_file'
  | 'batch';

export const CODEX_PATCH_PROXY_ACTIONS: CodexPatchProxyAction[] = [
  'add_file',
  'delete_file',
  'update_file',
  'replace_file',
  'batch',
];

export function applyPatchProxyToolName(action: CodexPatchProxyAction, baseName: string = APPLY_PATCH_TOOL_NAME): string {
  return `${baseName}_${action}`;
}

export function patchProxyActionFromName(name: string, baseName: string = APPLY_PATCH_TOOL_NAME): CodexPatchProxyAction | null {
  const prefix = `${baseName}_`;
  if (!name.startsWith(prefix)) {
    return null;
  }
  const suffix = name.slice(prefix.length);
  return isPatchProxyAction(suffix) ? suffix : null;
}

export function isApplyPatchToolDefinition(tool: unknown, name = ''): boolean {
  if (name === APPLY_PATCH_TOOL_NAME) {
    return true;
  }
  if (!tool || typeof tool !== 'object') {
    return false;
  }
  const definition = pointer(tool as JsonRecord, ['format', 'definition']);
  return typeof definition === 'string'
    && definition.includes('begin_patch')
    && definition.includes('end_patch')
    && definition.includes('add_hunk');
}

export function buildApplyPatchProxyTools(baseName: string = APPLY_PATCH_TOOL_NAME, description = ''): JsonRecord[] {
  return CODEX_PATCH_PROXY_ACTIONS.map((action) => ({
    type: 'function',
    function: omitUndefined({
      name: applyPatchProxyToolName(action, baseName),
      description: applyPatchProxyDescription(action, description),
      parameters: applyPatchProxyParameters(action),
    }),
  }));
}

export function buildCustomToolCallHistory(name: string, input: unknown): { name: string; arguments: string } {
  const text = responseOutputText(input);
  if (name !== APPLY_PATCH_TOOL_NAME && !text.startsWith('*** Begin Patch')) {
    return {
      name,
      arguments: JSON.stringify({ input: text }),
    };
  }

  const operations = parseApplyPatchOperations(text);
  if (operations.length === 1) {
    const action = singleApplyPatchAction(operations[0].type) ?? 'batch';
    return {
      name: applyPatchProxyToolName(action, name || APPLY_PATCH_TOOL_NAME),
      arguments: buildApplyPatchOperationArguments(operations[0], action),
    };
  }

  return {
    name: applyPatchProxyToolName('batch', name || APPLY_PATCH_TOOL_NAME),
    arguments: JSON.stringify({ operations, raw_patch: text }),
  };
}

export function reconstructCustomToolCallInput(argumentsText: string): string {
  const value = parseJsonObject(argumentsText);
  if (!value) {
    return argumentsText;
  }
  if ('input' in value) {
    return responseOutputText(value.input);
  }
  return argumentsText;
}

export function reconstructApplyPatchInput(
  action: CodexPatchProxyAction | null,
  argumentsText: string,
): string {
  const value = parseJsonObject(argumentsText);
  if (!value) {
    return argumentsText;
  }

  const rawPatch = stringValue(value.raw_patch) || stringValue(value.patch) || stringValue(value.input);
  if (rawPatch) {
    return rawPatch;
  }

  const operations = (() => {
    switch (action ?? 'batch') {
      case 'add_file':
        return [{
          type: 'add_file',
          path: stringValue(value.path),
          content: stringValue(value.content),
        }];
      case 'delete_file':
        return [{
          type: 'delete_file',
          path: stringValue(value.path),
        }];
      case 'update_file':
        return [{
          type: 'update_file',
          path: stringValue(value.path),
          move_to: stringValue(value.move_to),
          hunks: Array.isArray(value.hunks) ? value.hunks : [],
        }];
      case 'replace_file':
        return [{
          type: 'replace_file',
          path: stringValue(value.path),
          content: stringValue(value.content),
        }];
      case 'batch':
        return Array.isArray(value.operations) ? value.operations : [];
      default:
        return [];
    }
  })();

  return buildApplyPatchText(operations);
}

function applyPatchProxyDescription(action: CodexPatchProxyAction, baseDescription: string): string {
  const prefix = baseDescription.trim();
  const actionText = {
    add_file: 'Add a new file through Codex apply_patch.',
    delete_file: 'Delete a file through Codex apply_patch.',
    update_file: 'Update a file with one or more hunks through Codex apply_patch.',
    replace_file: 'Replace a file through Codex apply_patch.',
    batch: 'Apply one or more file changes through Codex apply_patch.',
  }[action];
  return prefix ? `${prefix}\n\n${actionText}` : actionText;
}

function applyPatchProxyParameters(action: CodexPatchProxyAction): JsonRecord {
  switch (action) {
    case 'add_file':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      };
    case 'delete_file':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      };
    case 'update_file':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          move_to: { type: 'string' },
          hunks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
            },
          },
        },
        required: ['path', 'hunks'],
      };
    case 'replace_file':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      };
    case 'batch':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          operations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
            },
          },
          raw_patch: { type: 'string' },
        },
        required: ['operations'],
      };
    default:
      return { type: 'object' };
  }
}

function parseApplyPatchOperations(text: string): JsonRecord[] {
  const lines = text.split(/\r?\n/u);
  const operations: JsonRecord[] = [];
  let current: JsonRecord | null = null;
  let currentHunk: { header: string; lines: string[] } | null = null;

  const flushHunk = () => {
    if (!current || !currentHunk) {
      return;
    }
    if (!Array.isArray(current.hunks)) {
      current.hunks = [];
    }
    current.hunks.push({
      header: currentHunk.header,
      lines: currentHunk.lines,
    });
    currentHunk = null;
  };

  const flushOperation = () => {
    flushHunk();
    if (current) {
      operations.push(current);
      current = null;
    }
  };

  for (const line of lines) {
    if (line === '*** Begin Patch' || line === '*** End Patch') {
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      flushOperation();
      current = {
        type: 'add_file',
        path: line.slice('*** Add File: '.length).trim(),
        content: '',
      };
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      flushOperation();
      current = {
        type: 'delete_file',
        path: line.slice('*** Delete File: '.length).trim(),
      };
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      flushOperation();
      current = {
        type: 'update_file',
        path: line.slice('*** Update File: '.length).trim(),
        hunks: [],
      };
      continue;
    }
    if (line.startsWith('*** Move to: ') && current?.type === 'update_file') {
      current.move_to = line.slice('*** Move to: '.length).trim();
      continue;
    }
    if (line.startsWith('@@') && current?.type === 'update_file') {
      flushHunk();
      currentHunk = {
        header: line.startsWith('@@ ') ? line.slice(3) : '',
        lines: [],
      };
      continue;
    }

    if (current?.type === 'add_file') {
      const contentLine = line.startsWith('+') ? line.slice(1) : line;
      current.content = current.content ? `${current.content}\n${contentLine}` : contentLine;
      continue;
    }
    if (current?.type === 'update_file') {
      if (!currentHunk) {
        currentHunk = { header: '', lines: [] };
      }
      currentHunk.lines.push(line);
    }
  }

  flushOperation();
  return operations;
}

function buildApplyPatchOperationArguments(operation: JsonRecord, action: CodexPatchProxyAction): string {
  switch (action) {
    case 'add_file':
      return JSON.stringify({
        path: stringValue(operation.path),
        content: stringValue(operation.content),
      });
    case 'delete_file':
      return JSON.stringify({
        path: stringValue(operation.path),
      });
    case 'update_file':
      return JSON.stringify({
        path: stringValue(operation.path),
        move_to: stringValue(operation.move_to),
        hunks: Array.isArray(operation.hunks) ? operation.hunks : [],
      });
    case 'replace_file':
      return JSON.stringify({
        path: stringValue(operation.path),
        content: stringValue(operation.content),
      });
    case 'batch':
      return JSON.stringify({
        operations: [operation],
      });
    default:
      return JSON.stringify({
        operations: [operation],
      });
  }
}

function buildApplyPatchText(operations: unknown[]): string {
  const lines = ['*** Begin Patch'];
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object') {
      continue;
    }
    const record = operation as JsonRecord;
    const type = stringValue(record.type);
    const path = stringValue(record.path);
    switch (type) {
      case 'add_file':
        lines.push(`*** Add File: ${path}`);
        for (const line of stringValue(record.content).split(/\r?\n/u)) {
          lines.push(`+${line}`);
        }
        break;
      case 'delete_file':
        lines.push(`*** Delete File: ${path}`);
        break;
      case 'update_file':
        lines.push(`*** Update File: ${path}`);
        if (stringValue(record.move_to)) {
          lines.push(`*** Move to: ${stringValue(record.move_to)}`);
        }
        for (const hunk of Array.isArray(record.hunks) ? record.hunks : []) {
          if (!hunk || typeof hunk !== 'object') {
            continue;
          }
          const header = stringValue((hunk as JsonRecord).header);
          lines.push(header ? `@@ ${header}` : '@@');
          for (const line of Array.isArray((hunk as JsonRecord).lines) ? (hunk as JsonRecord).lines : []) {
            lines.push(String(line));
          }
        }
        break;
      case 'replace_file':
        lines.push(`*** Delete File: ${path}`);
        lines.push(`*** Add File: ${path}`);
        for (const line of stringValue(record.content).split(/\r?\n/u)) {
          lines.push(`+${line}`);
        }
        break;
      default:
        break;
    }
  }
  lines.push('*** End Patch');
  return lines.join('\n');
}

function singleApplyPatchAction(type: unknown): CodexPatchProxyAction | null {
  const normalized = stringValue(type);
  return normalized === 'add_file'
    || normalized === 'delete_file'
    || normalized === 'update_file'
    || normalized === 'replace_file'
    ? normalized
    : null;
}

function isPatchProxyAction(value: string): value is CodexPatchProxyAction {
  return (CODEX_PATCH_PROXY_ACTIONS as string[]).includes(value);
}

function responseOutputText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  const record = value as JsonRecord;
  if (typeof record.text === 'string') {
    return record.text;
  }
  if (typeof record.output === 'string') {
    return record.output;
  }
  if (typeof record.input === 'string') {
    return record.input;
  }
  return JSON.stringify(value);
}

function parseJsonObject(text: string): JsonRecord | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonRecord
      : null;
  } catch {
    return null;
  }
}

function pointer(value: JsonRecord, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as JsonRecord)[segment];
  }
  return current;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function omitUndefined<T extends JsonRecord>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) {
      delete record[key];
    }
  }
  return record;
}
