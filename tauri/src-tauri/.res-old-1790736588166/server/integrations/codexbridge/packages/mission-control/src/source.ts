import type { MissionSource, WorkItem } from './types.js';

export interface WorkItemSourceSummary {
  source: MissionSource;
  sourceRef: string;
  sourceRevision: string | null;
  title: string;
  goal: string | null;
  expectedOutput: string | null;
  acceptanceCriteria: string[];
  plan: string[];
  metadata: Record<string, unknown> | null;
}

export interface WorkItemSourceCreateInput {
  source: MissionSource;
  sourceRef: string;
  sourceRevision?: string | null;
  title: string;
  goal?: string | null;
  expectedOutput?: string | null;
  acceptanceCriteria?: string[];
  plan?: string[];
  metadata?: Record<string, unknown> | null;
}

export interface WorkItemSourceListInput {
  status?: string[];
  cursor?: string | null;
  limit?: number;
}

export interface WorkItemSourceListResult {
  items: WorkItemSourceSummary[];
  nextCursor?: string | null;
}

export interface WorkItemSourceUpdateInput {
  sourceRef: string;
  sourceRevision?: string | null;
  title?: string | null;
  goal?: string | null;
  expectedOutput?: string | null;
  acceptanceCriteria?: string[] | null;
  plan?: string[] | null;
  metadata?: Record<string, unknown> | null;
}

export interface WorkItemSourceAdapter {
  createWorkItem(input: WorkItemSourceCreateInput): Promise<WorkItemSourceSummary>;
  getWorkItem(input: { sourceRef: string }): Promise<WorkItemSourceSummary | null>;
  listWorkItems(input?: WorkItemSourceListInput): Promise<WorkItemSourceListResult>;
  updateWorkItem(input: WorkItemSourceUpdateInput): Promise<void>;
}

export function createWorkItemSourceSummary(
  input: WorkItemSourceCreateInput,
): WorkItemSourceSummary {
  return {
    source: input.source,
    sourceRef: input.sourceRef,
    sourceRevision: normalizeText(input.sourceRevision) ?? null,
    title: normalizeRequiredText(input.title, 'title'),
    goal: normalizeText(input.goal) ?? null,
    expectedOutput: normalizeText(input.expectedOutput) ?? null,
    acceptanceCriteria: normalizeStringList(input.acceptanceCriteria),
    plan: normalizeStringList(input.plan),
    metadata: cloneRecord(input.metadata),
  };
}

export function createManualWorkItemSourceSummary(
  input: WorkItemSourceCreateInput,
): WorkItemSourceSummary {
  return createWorkItemSourceSummary(input);
}

export function createWorkItemSourceSummaryFromWorkItem(
  workItem: WorkItem,
  input: {
    goal?: string | null;
    acceptanceCriteria?: string[];
    plan?: string[];
  } = {},
): WorkItemSourceSummary {
  return {
    source: workItem.source,
    sourceRef: workItem.sourceRef ?? workItem.id,
    sourceRevision: workItem.sourceRevision,
    title: workItem.title,
    goal: normalizeText(input.goal) ?? workItem.immutableGoal,
    expectedOutput: workItem.expectedOutput,
    acceptanceCriteria: normalizeStringList(input.acceptanceCriteria),
    plan: normalizeStringList(input.plan),
    metadata: cloneRecord(workItem.metadata),
  };
}

function normalizeRequiredText(value: string, label: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new Error(`work item source ${label} is required`);
  }
  return normalized;
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringList(value: string[] | null | undefined): string[] {
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

function cloneRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return structuredClone(value);
}
