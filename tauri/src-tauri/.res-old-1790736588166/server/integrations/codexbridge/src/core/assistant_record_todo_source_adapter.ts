import crypto from 'node:crypto';
import {
  createWorkItemSourceSummary,
  type WorkItemSourceAdapter,
  type WorkItemSourceCreateInput,
  type WorkItemSourceListInput,
  type WorkItemSourceListResult,
  type WorkItemSourceSummary,
  type WorkItemSourceUpdateInput,
} from '../../packages/mission-control/src/index.js';
import { AssistantRecordService, type AssistantRecordDraft } from './assistant_record_service.js';
import type { AssistantRecord, AssistantRecordPriority, AssistantRecordStatus, PlatformScopeRef } from '../types/core.js';

const LOCAL_TODO_SOURCE_SCHEMA = 'codexbridge/mission-control/local-todo/v1';
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

interface AssistantRecordTodoSourceAdapterOptions {
  assistantRecords: AssistantRecordService;
  scopeRef: PlatformScopeRef;
  contextThreadId?: string | null;
  timezone?: string | null;
}

interface LocalTodoSourceState {
  goal: string | null;
  expectedOutput: string | null;
  acceptanceCriteria: string[];
  plan: string[];
  metadata: Record<string, unknown> | null;
  structured: boolean;
  contentDigestMatches: boolean;
}

interface LocalTodoSourcePayload {
  schema: string;
  contentDigest: string;
  goal: string | null;
  expectedOutput: string | null;
  acceptanceCriteria: string[];
  plan: string[];
  metadata: Record<string, unknown> | null;
}

export class AssistantRecordTodoSourceAdapter implements WorkItemSourceAdapter {
  private readonly assistantRecords: AssistantRecordService;

  private readonly scopeRef: PlatformScopeRef;

  private readonly contextThreadId: string | null;

  private readonly timezone: string | null;

  constructor({
    assistantRecords,
    scopeRef,
    contextThreadId = null,
    timezone = null,
  }: AssistantRecordTodoSourceAdapterOptions) {
    this.assistantRecords = assistantRecords;
    this.scopeRef = scopeRef;
    this.contextThreadId = normalizeText(contextThreadId);
    this.timezone = normalizeText(timezone);
  }

  async createWorkItem(input: WorkItemSourceCreateInput): Promise<WorkItemSourceSummary> {
    const summary = createWorkItemSourceSummary({
      ...input,
      source: 'local-todo',
    });
    const draft = createAssistantRecordDraftFromSourceSummary(summary);
    const created = await this.assistantRecords.createRecord({
      scopeRef: this.scopeRef,
      source: 'manual',
      contextThreadId: this.contextThreadId,
      timezone: this.timezone,
      status: 'active',
      parseStatus: 'confirmed',
      draft,
    });
    const canonical = this.assistantRecords.updateRecord(created.id, {
      title: summary.title,
      content: draft.content,
      originalText: draft.originalText,
      priority: draft.priority,
      project: draft.project,
      tags: draft.tags,
      parsedJson: draft.parsedJson,
      parseStatus: 'confirmed',
    });
    return createAssistantRecordTodoSourceSummary(canonical);
  }

  async getWorkItem(input: { sourceRef: string }): Promise<WorkItemSourceSummary | null> {
    const record = this.getRecord(input.sourceRef);
    return record ? createAssistantRecordTodoSourceSummary(record) : null;
  }

  async listWorkItems(input: WorkItemSourceListInput = {}): Promise<WorkItemSourceListResult> {
    const statuses = normalizeStatusSet(input.status);
    const offset = normalizeCursor(input.cursor);
    const limit = normalizeListLimit(input.limit);
    const records = this.assistantRecords
      .listForScope(this.scopeRef, 'todo')
      .filter((record) => statuses === null || statuses.has(record.status))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const slice = records.slice(offset, offset + limit);
    return {
      items: slice.map((record) => createAssistantRecordTodoSourceSummary(record)),
      nextCursor: offset + slice.length < records.length ? String(offset + slice.length) : null,
    };
  }

  async updateWorkItem(input: WorkItemSourceUpdateInput): Promise<void> {
    const record = this.requireRecord(input.sourceRef);
    const state = readAssistantRecordTodoSourceState(record);
    const nextSummary = createWorkItemSourceSummary({
      source: 'local-todo',
      sourceRef: record.id,
      title: hasOwn(input, 'title') ? input.title ?? record.title : record.title,
      goal: hasOwn(input, 'goal') ? input.goal ?? null : state.goal,
      expectedOutput: hasOwn(input, 'expectedOutput') ? input.expectedOutput ?? null : state.expectedOutput,
      acceptanceCriteria: hasOwn(input, 'acceptanceCriteria') ? input.acceptanceCriteria ?? [] : state.acceptanceCriteria,
      plan: hasOwn(input, 'plan') ? input.plan ?? [] : state.plan,
      metadata: hasOwn(input, 'metadata') ? input.metadata ?? null : state.metadata,
    });
    const nextDraft = createAssistantRecordDraftFromSourceSummary(nextSummary, {
      existingParsedJson: record.parsedJson,
    });
    this.assistantRecords.updateRecord(record.id, {
      title: nextSummary.title,
      content: nextDraft.content,
      originalText: nextDraft.originalText,
      priority: nextDraft.priority,
      project: nextDraft.project,
      tags: nextDraft.tags,
      parsedJson: nextDraft.parsedJson,
      parseStatus: 'confirmed',
    });
  }

  private getRecord(sourceRef: string): AssistantRecord | null {
    const record = this.assistantRecords.getById(normalizeRequiredText(sourceRef, 'sourceRef'));
    if (!record || record.type !== 'todo' || record.status === 'archived') {
      return null;
    }
    if (record.platform !== this.scopeRef.platform || record.scopeId !== this.scopeRef.externalScopeId) {
      return null;
    }
    return record;
  }

  private requireRecord(sourceRef: string): AssistantRecord {
    const record = this.getRecord(sourceRef);
    if (!record) {
      throw new Error(`unknown local todo source: ${sourceRef}`);
    }
    return record;
  }
}

export function createAssistantRecordTodoSourceSummary(record: AssistantRecord): WorkItemSourceSummary {
  const state = readAssistantRecordTodoSourceState(record);
  const fallbackGoal = normalizeText(record.content) ?? record.title;
  const goal = state.goal ?? fallbackGoal;
  const expectedOutput = state.expectedOutput ?? goal;
  return createWorkItemSourceSummary({
    source: 'local-todo',
    sourceRef: record.id,
    sourceRevision: buildAssistantRecordSourceRevision(record),
    title: record.title,
    goal,
    expectedOutput,
    acceptanceCriteria: state.acceptanceCriteria,
    plan: state.plan,
    metadata: buildSummaryMetadata(record, state),
  });
}

function readAssistantRecordTodoSourceState(record: AssistantRecord): LocalTodoSourceState {
  const payload = readLocalTodoSourcePayload(record.parsedJson);
  if (!payload) {
    return {
      goal: normalizeText(record.content),
      expectedOutput: normalizeText(record.content),
      acceptanceCriteria: [],
      plan: [],
      metadata: null,
      structured: false,
      contentDigestMatches: false,
    };
  }
  const contentDigestMatches = payload.contentDigest === hashContentForDigest(record.content);
  if (!contentDigestMatches) {
    return {
      goal: normalizeText(record.content),
      expectedOutput: normalizeText(record.content),
      acceptanceCriteria: [],
      plan: [],
      metadata: cloneRecord(payload.metadata),
      structured: true,
      contentDigestMatches: false,
    };
  }
  return {
    goal: payload.goal,
    expectedOutput: payload.expectedOutput,
    acceptanceCriteria: [...payload.acceptanceCriteria],
    plan: [...payload.plan],
    metadata: cloneRecord(payload.metadata),
    structured: true,
    contentDigestMatches: true,
  };
}

function createAssistantRecordDraftFromSourceSummary(
  summary: WorkItemSourceSummary,
  options: {
    existingParsedJson?: Record<string, unknown> | null;
  } = {},
): AssistantRecordDraft {
  const goal = summary.goal ?? summary.title;
  const expectedOutput = summary.expectedOutput ?? goal;
  const metadata = stripAssistantRecordMetadata(summary.metadata);
  const content = renderLocalTodoContent({
    goal,
    expectedOutput,
    acceptanceCriteria: summary.acceptanceCriteria,
    plan: summary.plan,
  });
  const parsedJson = mergeRecord(
    options.existingParsedJson,
    {
      missionControlLocalTodo: {
        schema: LOCAL_TODO_SOURCE_SCHEMA,
        contentDigest: hashContentForDigest(content),
        goal,
        expectedOutput,
        acceptanceCriteria: [...summary.acceptanceCriteria],
        plan: [...summary.plan],
        metadata,
      } satisfies LocalTodoSourcePayload,
    },
  );
  const hints = extractAssistantRecordHints(metadata);
  return {
    type: 'todo',
    title: summary.title,
    content,
    originalText: content,
    priority: hints.priority,
    project: hints.project,
    tags: hints.tags,
    dueAt: null,
    remindAt: null,
    recurrence: null,
    confidence: 1,
    parsedJson,
  };
}

function buildSummaryMetadata(
  record: AssistantRecord,
  state: LocalTodoSourceState,
): Record<string, unknown> | null {
  return mergeRecord(
    state.metadata,
    {
      assistantRecord: {
        id: record.id,
        type: record.type,
        status: record.status,
        source: record.source,
        platform: record.platform,
        scopeId: record.scopeId,
        priority: record.priority,
        project: record.project,
        tags: [...record.tags],
        dueAt: record.dueAt,
        remindAt: record.remindAt,
        recurrence: record.recurrence,
        timezone: record.timezone,
        parseStatus: record.parseStatus,
        updatedAt: record.updatedAt,
        attachmentCount: record.attachments.length,
      },
      sourceAdapter: {
        kind: 'assistant-record-local-todo',
        structured: state.structured,
        contentDigestMatches: state.contentDigestMatches,
      },
    },
  );
}

function readLocalTodoSourcePayload(value: Record<string, unknown> | null): LocalTodoSourcePayload | null {
  const payload = value?.missionControlLocalTodo;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  if (raw.schema !== LOCAL_TODO_SOURCE_SCHEMA) {
    return null;
  }
  return {
    schema: LOCAL_TODO_SOURCE_SCHEMA,
    contentDigest: normalizeRequiredText(raw.contentDigest, 'contentDigest'),
    goal: normalizeText(raw.goal),
    expectedOutput: normalizeText(raw.expectedOutput),
    acceptanceCriteria: normalizeStringList(raw.acceptanceCriteria),
    plan: normalizeStringList(raw.plan),
    metadata: cloneRecord(raw.metadata),
  };
}

function buildAssistantRecordSourceRevision(record: AssistantRecord): string {
  return `assistant-record:${record.updatedAt}:${hashText(JSON.stringify({
    id: record.id,
    status: record.status,
    title: record.title,
    content: record.content,
    priority: record.priority,
    project: record.project,
    tags: record.tags,
    dueAt: record.dueAt,
    remindAt: record.remindAt,
    recurrence: record.recurrence,
    parsedJson: record.parsedJson,
  }))}`;
}

function renderLocalTodoContent(input: {
  goal: string;
  expectedOutput: string;
  acceptanceCriteria: string[];
  plan: string[];
}): string {
  const lines = [
    input.goal,
  ];
  if (input.expectedOutput !== input.goal) {
    lines.push('');
    lines.push('Expected output:');
    lines.push(input.expectedOutput);
  }
  if (input.acceptanceCriteria.length > 0) {
    lines.push('');
    lines.push('Acceptance criteria:');
    for (const item of input.acceptanceCriteria) {
      lines.push(`- ${item}`);
    }
  }
  if (input.plan.length > 0) {
    lines.push('');
    lines.push('Plan:');
    for (const item of input.plan) {
      lines.push(`- ${item}`);
    }
  }
  return lines.join('\n').trim();
}

function extractAssistantRecordHints(
  metadata: Record<string, unknown> | null,
): {
  priority: AssistantRecordPriority;
  project: string | null;
  tags: string[];
} {
  const priority = metadata?.priority;
  return {
    priority: priority === 'low' || priority === 'normal' || priority === 'high' ? priority : 'normal',
    project: normalizeText(metadata?.project),
    tags: normalizeStringList(metadata?.tags),
  };
}

function stripAssistantRecordMetadata(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  const next = cloneRecord(value) ?? {};
  delete next.assistantRecord;
  delete next.sourceAdapter;
  return Object.keys(next).length > 0 ? next : null;
}

function normalizeStatusSet(value: string[] | undefined): Set<AssistantRecordStatus> | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const set = new Set<AssistantRecordStatus>();
  for (const entry of value) {
    const normalized = normalizeText(entry);
    switch (normalized) {
      case 'pending':
      case 'active':
      case 'done':
      case 'cancelled':
      case 'archived':
        set.add(normalized);
        break;
    }
  }
  return set.size > 0 ? set : null;
}

function normalizeCursor(value: string | null | undefined): number {
  if (typeof value !== 'string') {
    return 0;
  }
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function normalizeListLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(Math.max(1, Math.trunc(value)), MAX_LIST_LIMIT);
}

function normalizeRequiredText(value: unknown, label: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: string[] = [];
  for (const entry of value) {
    const text = normalizeText(entry);
    if (!text) {
      continue;
    }
    normalized.push(text);
  }
  return normalized;
}

function cloneRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return structuredClone(value as Record<string, unknown>);
}

function mergeRecord(
  base: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(cloneRecord(base) ?? {}),
    ...patch,
  };
}

function hashText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashContentForDigest(value: string): string {
  return hashText(normalizeDigestText(value));
}

function normalizeDigestText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hasOwn<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}
