import type { SessionSettings } from '../types/core.js';

export type LegacyAccessPreset = 'read-only' | 'default' | 'full-access';

export type ResolvedPermissionsState = {
  permissionsMode: NonNullable<SessionSettings['permissionsMode']>;
  accessPreset: LegacyAccessPreset | null;
  approvalPolicy: string | null;
  sandboxMode: string | null;
  approvalsReviewer: NonNullable<SessionSettings['approvalsReviewer']> | null;
  usesProfileDefaults: boolean;
};

const PERMISSIONS_MODES = new Set<NonNullable<SessionSettings['permissionsMode']>>([
  'default-permissions',
  'auto-review',
  'full-access',
  'custom',
]);

const LEGACY_ACCESS_PRESETS = new Set<LegacyAccessPreset>([
  'read-only',
  'default',
  'full-access',
]);

export function normalizeApprovalsReviewer(
  value: unknown,
): NonNullable<SessionSettings['approvalsReviewer']> | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'user' || normalized === 'auto_review') {
    return normalized;
  }
  return null;
}

export function normalizePermissionsMode(
  value: unknown,
): NonNullable<SessionSettings['permissionsMode']> | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (PERMISSIONS_MODES.has(normalized as NonNullable<SessionSettings['permissionsMode']>)) {
    return normalized as NonNullable<SessionSettings['permissionsMode']>;
  }
  return null;
}

export function normalizeLegacyAccessPreset(value: unknown): LegacyAccessPreset | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (LEGACY_ACCESS_PRESETS.has(normalized as LegacyAccessPreset)) {
    return normalized as LegacyAccessPreset;
  }
  return null;
}

export function buildPermissionsSettingsUpdate(
  mode: NonNullable<SessionSettings['permissionsMode']>,
): Partial<SessionSettings> {
  switch (mode) {
    case 'auto-review':
      return {
        permissionsMode: mode,
        accessPreset: 'default',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        approvalsReviewer: 'auto_review',
      };
    case 'full-access':
      return {
        permissionsMode: mode,
        accessPreset: 'full-access',
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
        approvalsReviewer: null,
      };
    case 'custom':
      return {
        permissionsMode: mode,
        accessPreset: null,
        approvalPolicy: null,
        sandboxMode: null,
        approvalsReviewer: null,
      };
    case 'default-permissions':
    default:
      return {
        permissionsMode: 'default-permissions',
        accessPreset: 'default',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        approvalsReviewer: 'user',
      };
  }
}

export function buildLegacyReadOnlyCustomSettingsUpdate(): Partial<SessionSettings> {
  return {
    permissionsMode: 'custom',
    accessPreset: 'read-only',
    approvalPolicy: 'on-request',
    sandboxMode: 'read-only',
    approvalsReviewer: 'user',
  };
}

export function resolvePermissionsState(
  settings: Pick<
    SessionSettings,
    'permissionsMode' | 'accessPreset' | 'approvalPolicy' | 'sandboxMode' | 'approvalsReviewer'
  > | null | undefined,
): ResolvedPermissionsState {
  const explicitMode = normalizePermissionsMode(settings?.permissionsMode);
  const reviewer = normalizeApprovalsReviewer(settings?.approvalsReviewer);

  if (explicitMode === 'default-permissions') {
    return {
      permissionsMode: explicitMode,
      accessPreset: 'default',
      approvalPolicy: settings?.approvalPolicy ?? 'on-request',
      sandboxMode: settings?.sandboxMode ?? 'workspace-write',
      approvalsReviewer: reviewer ?? 'user',
      usesProfileDefaults: false,
    };
  }

  if (explicitMode === 'auto-review') {
    return {
      permissionsMode: explicitMode,
      accessPreset: 'default',
      approvalPolicy: settings?.approvalPolicy ?? 'on-request',
      sandboxMode: settings?.sandboxMode ?? 'workspace-write',
      approvalsReviewer: reviewer ?? 'auto_review',
      usesProfileDefaults: false,
    };
  }

  if (explicitMode === 'full-access') {
    return {
      permissionsMode: explicitMode,
      accessPreset: 'full-access',
      approvalPolicy: settings?.approvalPolicy ?? 'never',
      sandboxMode: settings?.sandboxMode ?? 'danger-full-access',
      approvalsReviewer: null,
      usesProfileDefaults: false,
    };
  }

  if (explicitMode === 'custom') {
    return {
      permissionsMode: explicitMode,
      accessPreset: normalizeLegacyAccessPreset(settings?.accessPreset),
      approvalPolicy: settings?.approvalPolicy ?? null,
      sandboxMode: settings?.sandboxMode ?? null,
      approvalsReviewer: reviewer,
      usesProfileDefaults: settings?.approvalPolicy == null
        && settings?.sandboxMode == null
        && reviewer == null,
    };
  }

  const legacyPreset = normalizeLegacyAccessPreset(settings?.accessPreset);
  if (legacyPreset === 'full-access') {
    return {
      permissionsMode: 'full-access',
      accessPreset: legacyPreset,
      approvalPolicy: settings?.approvalPolicy ?? 'never',
      sandboxMode: settings?.sandboxMode ?? 'danger-full-access',
      approvalsReviewer: null,
      usesProfileDefaults: false,
    };
  }
  if (legacyPreset === 'default') {
    return {
      permissionsMode: 'default-permissions',
      accessPreset: legacyPreset,
      approvalPolicy: settings?.approvalPolicy ?? 'on-request',
      sandboxMode: settings?.sandboxMode ?? 'workspace-write',
      approvalsReviewer: reviewer ?? 'user',
      usesProfileDefaults: false,
    };
  }
  if (legacyPreset === 'read-only') {
    return {
      permissionsMode: 'custom',
      accessPreset: legacyPreset,
      approvalPolicy: settings?.approvalPolicy ?? 'on-request',
      sandboxMode: settings?.sandboxMode ?? 'read-only',
      approvalsReviewer: reviewer ?? 'user',
      usesProfileDefaults: false,
    };
  }

  if (settings?.sandboxMode === 'danger-full-access' && settings?.approvalPolicy === 'never') {
    return {
      permissionsMode: 'full-access',
      accessPreset: 'full-access',
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
      approvalsReviewer: null,
      usesProfileDefaults: false,
    };
  }

  if (settings?.sandboxMode === 'workspace-write' && settings?.approvalPolicy === 'on-request') {
    if (reviewer === 'auto_review') {
      return {
        permissionsMode: 'auto-review',
        accessPreset: 'default',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        approvalsReviewer: 'auto_review',
        usesProfileDefaults: false,
      };
    }
    return {
      permissionsMode: 'default-permissions',
      accessPreset: 'default',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      approvalsReviewer: reviewer ?? 'user',
      usesProfileDefaults: false,
    };
  }

  return {
    permissionsMode: 'custom',
    accessPreset: null,
    approvalPolicy: settings?.approvalPolicy ?? null,
    sandboxMode: settings?.sandboxMode ?? null,
    approvalsReviewer: reviewer,
    usesProfileDefaults: settings?.approvalPolicy == null
      && settings?.sandboxMode == null
      && reviewer == null,
  };
}

export function buildCodexPermissionRuntimeOverrides(
  settings: Pick<
    SessionSettings,
    'permissionsMode' | 'accessPreset' | 'approvalPolicy' | 'sandboxMode' | 'approvalsReviewer'
  > | null | undefined,
): {
  approvalPolicy: string | null;
  sandboxMode: string | null;
  configOverrides: Record<string, unknown> | null;
} {
  const resolved = resolvePermissionsState(settings);
  switch (resolved.permissionsMode) {
    case 'auto-review':
      return {
        approvalPolicy: resolved.approvalPolicy,
        sandboxMode: resolved.sandboxMode,
        configOverrides: { approvals_reviewer: 'auto_review' },
      };
    case 'default-permissions':
      return {
        approvalPolicy: resolved.approvalPolicy,
        sandboxMode: resolved.sandboxMode,
        configOverrides: { approvals_reviewer: 'user' },
      };
    case 'full-access':
      return {
        approvalPolicy: resolved.approvalPolicy,
        sandboxMode: resolved.sandboxMode,
        configOverrides: null,
      };
    case 'custom':
    default:
      return {
        approvalPolicy: null,
        sandboxMode: null,
        configOverrides: null,
      };
  }
}
