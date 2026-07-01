# Codex Permissions 4-Mode Alignment Spec

## Goal

Align CodexBridge with the current official Codex app permission model so the bridge, CLI command surface, stored session settings, and Web composer all use the same four top-level permission modes:

1. `default-permissions`
2. `auto-review`
3. `full-access`
4. `custom`

This replaces the current bridge-centric 3-preset model:

- `read-only`
- `default`
- `full-access`

The main product requirement is that CodexBridge should no longer invent its own top-level permission states when the official Codex app already defines the user-facing model.

## Source Of Truth

Official Codex sandboxing docs:

- `Default permissions` -> `sandbox_mode=workspace-write`, `approval_policy=on-request`, reviewer `user`
- `Auto-review` -> `sandbox_mode=workspace-write`, `approval_policy=on-request`, reviewer `auto_review`
- `Full access` -> `sandbox_mode=danger-full-access`, `approval_policy=never`
- `Custom (config.toml)` -> use local `config.toml` profile/config without bridge-level override

Reference:

- <https://developers.openai.com/codex/concepts/sandboxing#how-you-control-it>

## Product Rules

### Top-level permission modes

Only these four modes should be exposed in the main UX:

- `default-permissions`
- `auto-review`
- `full-access`
- `custom`

### Read-only handling

`read-only` is no longer a top-level composer mode.

If an old session still uses the legacy bridge preset `read-only`, it should be treated as:

- `permissionsMode = custom`
- keep its raw `sandboxMode` / `approvalPolicy` values

This preserves behavior without misrepresenting the session as one of the official four modes.

### Custom mode

`custom` means:

- CodexBridge must not force `sandboxMode`
- CodexBridge must not force `approvalPolicy`
- CodexBridge must not force `approvalsReviewer`

The turn should defer to the local Codex configuration profile / `config.toml`.

This is the most important semantic change in this spec.

### Auto-review

`auto-review` keeps the same sandbox boundary as `default-permissions`.

The only semantic difference is reviewer routing:

- `approvalsReviewer = auto_review`

CodexBridge must store this separately from `approvalPolicy` and `sandboxMode`.

## Data Model

### Session settings

Add canonical fields:

- `permissionsMode?: 'default-permissions' | 'auto-review' | 'full-access' | 'custom' | null`
- `approvalsReviewer?: 'user' | 'auto_review' | null`

Keep existing raw fields:

- `approvalPolicy?: string | null`
- `sandboxMode?: string | null`

Keep legacy field temporarily for migration/fallback:

- `accessPreset?: 'read-only' | 'default' | 'full-access' | null`

### Compatibility policy

`permissionsMode` becomes the canonical field for new UI and command behavior.

`accessPreset` remains as:

- migration source
- backward-compatibility field
- optional legacy alias sink

## Mode Mapping

### Canonical 4-mode mapping

#### `default-permissions`

- `sandboxMode = workspace-write`
- `approvalPolicy = on-request`
- `approvalsReviewer = user`
- legacy `accessPreset = default`

#### `auto-review`

- `sandboxMode = workspace-write`
- `approvalPolicy = on-request`
- `approvalsReviewer = auto_review`
- legacy `accessPreset = default`

#### `full-access`

- `sandboxMode = danger-full-access`
- `approvalPolicy = never`
- `approvalsReviewer = null`
- legacy `accessPreset = full-access`

#### `custom`

- `sandboxMode = null`
- `approvalPolicy = null`
- `approvalsReviewer = null`
- legacy `accessPreset = null`

Important: `custom` intentionally clears bridge overrides. It does not mean “store a new synthetic preset”.

## Legacy Migration Rules

When `permissionsMode` is missing, infer it in this order:

1. If legacy `accessPreset = full-access` -> `full-access`
2. If legacy `accessPreset = default` -> `default-permissions`
3. If legacy `accessPreset = read-only` -> `custom`
4. If raw values match:
   - `workspace-write + on-request + auto_review` -> `auto-review`
   - `workspace-write + on-request + user|null` -> `default-permissions`
   - `danger-full-access + never` -> `full-access`
5. Otherwise -> `custom`

If a session resolves to `custom`, raw values remain authoritative for display until the user explicitly switches modes.

## Bridge Behavior

### `/permissions`

The command surface should move to official modes:

- `/permissions default-permissions`
- `/permissions auto-review`
- `/permissions full-access`
- `/permissions custom`

Short-term compatibility aliases may still be accepted:

- `default` -> `default-permissions`
- `full-access` -> `full-access`
- `read-only` -> legacy custom conversion

The help output should only advertise the official 4 modes.

### Status rendering

Status/help output should report:

- current permission mode
- approval policy
- sandbox mode
- reviewer

For `custom`, display `Configured in profile` for unset values.

For `full-access`, reviewer should display `Not Applicable`.

## Provider Behavior

### Non-custom modes

For:

- `default-permissions`
- `auto-review`
- `full-access`

CodexBridge should compute explicit runtime overrides from the canonical mode.

### Custom mode

For `custom`, provider requests must omit bridge-level permission overrides so Codex falls back to local `config.toml`.

That means no forced:

- `approvalPolicy`
- `sandboxMode`

### Reviewer propagation

`auto-review` should propagate reviewer intent as a config override payload where supported.

Bridge implementation target:

- `default-permissions` -> config override reviewer `user`
- `auto-review` -> config override reviewer `auto_review`
- `full-access` -> no reviewer override
- `custom` -> no override

This keeps `default-permissions` from silently inheriting a global `auto_review` config and keeps `custom` truly config-driven.

## Web UI

### Composer permissions pill

Add one permissions pill to the composer with exactly 4 visible options:

- `请求批准`
- `替我审批`
- `完全访问`
- `自定义`

Menu descriptions:

- `请求批准`: 工作区可写，越界时询问
- `替我审批`: 工作区可写，由审查代理处理合格审批
- `完全访问`: 不受沙箱限制
- `自定义`: 使用本地 config.toml 配置

The composer must not expose raw low-level fields directly.

### Web API

Add a thread-scoped settings API so the current thread page can:

- read the effective permission mode
- update the current session settings for that thread

Implementation target:

- `GET /api/codex-threads/[threadId]/settings`
- `POST /api/codex-threads/[threadId]/settings`

POST should use a worker/runtime path so it can bind a thread to a bridge session if none exists yet.

## Testing

### Core tests

Add or update tests for:

- mode inference from legacy `accessPreset`
- `/permissions` help and status output
- `/permissions auto-review`
- `/permissions custom`
- custom mode no-override behavior

### Provider tests

Add or update tests for:

- default-permissions -> explicit workspace-write + on-request + reviewer user override
- auto-review -> explicit workspace-write + on-request + reviewer auto_review override
- full-access -> explicit danger-full-access + never
- custom -> no bridge-level permission override

### Web tests / verification

At minimum verify:

- composer shows the 4 official modes
- selecting a mode persists it
- page reload shows the same mode
- custom mode does not regress to workspace-write + on-request

## Delivery Plan

### Phase 1

- Add spec
- Add canonical permission types
- Add shared permission resolution helpers

### Phase 2

- Update bridge command/status/help
- Update storage model and migration behavior

### Phase 3

- Update codex provider runtime override behavior
- Make `custom` truly defer to local config

### Phase 4

- Add Web settings API and composer permissions pill

### Phase 5

- Update tests
- Run focused verification
