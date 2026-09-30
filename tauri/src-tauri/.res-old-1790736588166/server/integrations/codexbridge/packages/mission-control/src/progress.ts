import type { MissionRepository } from './repository.js';
import type {
  Mission,
  MissionEvent,
  MissionWorkpad,
} from './types.js';

export type MissionProgressKind = 'summary' | 'substep' | 'blocker' | 'note' | 'artifact';

export interface MissionProgressUpdate {
  missionId: string;
  attemptId: string | null;
  checklistItemId: string | null;
  kind: MissionProgressKind;
  message: string;
  metadata?: Record<string, unknown> | null;
}

export interface MissionProgressSink {
  appendProgress(update: MissionProgressUpdate): Promise<void>;
}

export interface PersistMissionProgressUpdateOptions {
  repository: MissionRepository;
  update: MissionProgressUpdate;
  now?: () => number;
  generateId?: () => string;
  maxNotes?: number;
}

export class RepositoryMissionProgressSink implements MissionProgressSink {
  private readonly repository: MissionRepository;

  private readonly now: () => number;

  private readonly generateId: () => string;

  private readonly maxNotes: number;

  constructor({
    repository,
    now = () => Date.now(),
    generateId = () => `mission-progress-${Math.random().toString(16).slice(2)}`,
    maxNotes = 24,
  }: {
    repository: MissionRepository;
    now?: () => number;
    generateId?: () => string;
    maxNotes?: number;
  }) {
    this.repository = repository;
    this.now = now;
    this.generateId = generateId;
    this.maxNotes = maxNotes;
  }

  async appendProgress(update: MissionProgressUpdate): Promise<void> {
    persistMissionProgressUpdate({
      repository: this.repository,
      update,
      now: this.now,
      generateId: this.generateId,
      maxNotes: this.maxNotes,
    });
  }
}

export function persistMissionProgressUpdate({
  repository,
  update,
  now = () => Date.now(),
  generateId = () => `mission-progress-${Math.random().toString(16).slice(2)}`,
  maxNotes = 24,
}: PersistMissionProgressUpdateOptions): Mission | null {
  const mission = repository.getMissionById(update.missionId);
  if (!mission) {
    return null;
  }
  const message = normalizeText(update.message);
  if (!message) {
    return mission;
  }
  const at = now();
  const nextMission: Mission = {
    ...mission,
    workpad: applyMissionProgressUpdateToWorkpad(mission.workpad, update, at, maxNotes),
    updatedAt: at,
  };
  repository.saveMission(nextMission);

  const attemptId = normalizeAttemptId(repository, mission.id, update.attemptId);
  const eventKind: MissionEvent['kind'] = attemptId ? 'attempt.progress' : 'mission.progress';
  repository.appendEvent({
    id: generateId(),
    missionId: mission.id,
    attemptId,
    generationId: mission.activeGenerationId,
    generationIndex: mission.activeGenerationIndex,
    kind: eventKind,
    summary: message,
    detail: null,
    metadata: {
      kind: update.kind,
      checklistItemId: normalizeText(update.checklistItemId) ?? null,
      metadata: cloneRecord(update.metadata),
    },
    createdAt: at,
  });
  return nextMission;
}

export function applyMissionProgressUpdateToWorkpad(
  workpad: MissionWorkpad,
  update: MissionProgressUpdate,
  at: number,
  maxNotes = 24,
): MissionWorkpad {
  const message = normalizeText(update.message);
  if (!message) {
    return {
      ...workpad,
      updatedAt: at,
    };
  }

  const next: MissionWorkpad = {
    ...workpad,
    notes: [...workpad.notes],
    updatedAt: at,
  };

  switch (update.kind) {
    case 'summary':
      next.summary = message;
      break;
    case 'blocker':
      next.latestBlocker = message;
      break;
    case 'substep':
    case 'note':
    case 'artifact':
      break;
  }

  const note = formatProgressNote(update.kind, message);
  if (note && next.notes.at(-1) !== note) {
    next.notes.push(note);
  }
  if (next.notes.length > maxNotes) {
    next.notes.splice(0, next.notes.length - maxNotes);
  }
  return next;
}

function normalizeAttemptId(
  repository: MissionRepository,
  missionId: string,
  attemptId: string | null,
): string | null {
  const normalized = normalizeText(attemptId);
  if (!normalized) {
    return null;
  }
  const attempt = repository.getAttemptById(normalized);
  return attempt?.missionId === missionId ? attempt.id : null;
}

function formatProgressNote(kind: MissionProgressKind, message: string): string | null {
  switch (kind) {
    case 'summary':
      return `Summary: ${message}`;
    case 'blocker':
      return `Blocker: ${message}`;
    case 'artifact':
      return `Artifact: ${message}`;
    case 'substep':
    case 'note':
      return message;
  }
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cloneRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return structuredClone(value);
}
