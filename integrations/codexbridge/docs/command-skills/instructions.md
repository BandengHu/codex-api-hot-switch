# CodexBridge Command Skill: /instructions

## Purpose

This file defines how Codex should understand and normalize natural-language CodexBridge `/instructions` requests when Bridge explicitly asks Codex to use this project-local command skill.

`/instructions` manages the active Codex profile `AGENTS.md`. Codex may interpret user intent and return a structured proposal, but Bridge is the only component allowed to write, clear, confirm, cancel, or persist instruction changes.

Return exactly one JSON object. Do not use Markdown, prose, code fences, tool calls, or side effects.

## Invocation

Bridge invokes this skill only for semantic forms such as:

1. `/instructions <natural language>`
2. `/instructions edit <natural language>`

Bridge should continue handling these forms locally:

- `/instructions`
- `/instructions set <text>`
- `/instructions edit`
- `/instructions clear`
- `/instructions ok`
- `/instructions confirm`
- `/instructions cancel`
- `/instructions -h`
- `/instructions --help`

Bridge sends a prompt with a payload similar to:

```json
{
  "command": "instructions",
  "subcommand": "natural | edit",
  "rawText": "original user message",
  "userInput": "natural-language part after /instructions or /instructions edit",
  "now": "ISO timestamp",
  "locale": "zh-CN",
  "scope": {
    "platform": "weixin",
    "externalScopeId": "..."
  },
  "cwd": "/path/to/repo",
  "instructionsPath": "/home/ubuntu/.codex/AGENTS.md",
  "currentInstructions": {
    "exists": true,
    "content": "current AGENTS.md content"
  },
  "pendingDraft": {
    "kind": "patch",
    "rawInput": "previous request",
    "baseContent": "current live AGENTS.md content before the draft",
    "proposedContent": "current pending draft content",
    "summary": "short pending summary",
    "changes": ["change 1", "change 2"]
  },
  "capabilities": {
    "supportedActions": [
      "propose_patch",
      "propose_replace",
      "propose_clear",
      "update_pending_draft",
      "clarify",
      "reject",
      "local_only"
    ],
    "supportedProposalKinds": [
      "patch",
      "replace",
      "clear"
    ]
  },
  "skillPath": "docs/command-skills/instructions.md"
}
```

Use only `currentInstructions` and `pendingDraft` from the payload as state. Do not invent file contents, drafts, or confirmation state.

## Output Contract

Every response must include:

```json
{
  "schemaVersion": "codexbridge.instructions-command-skill.v1",
  "ok": true,
  "action": "one_action_name",
  "confidence": 0.9,
  "requiresConfirmation": true
}
```

Use `ok: false` for `clarify` and `reject`. Use confidence from `0` to `1`.

Action summary:

| Action | Purpose | Confirmation |
| --- | --- | --- |
| `propose_patch` | Propose an incremental change to the current `AGENTS.md` | true |
| `propose_replace` | Propose replacing the full `AGENTS.md` content | true |
| `propose_clear` | Propose clearing the current `AGENTS.md` | true |
| `update_pending_draft` | Replace the current pending draft with a newly edited full proposal | true |
| `clarify` | Ask the user to disambiguate | false |
| `reject` | Refuse routing outside `/instructions` | false |
| `local_only` | Tell Bridge this should be handled locally | false |

## Subcommand Rules

### `subcommand: "natural"`

Route the user's intent. Allowed actions:

- `propose_patch`
- `propose_replace`
- `propose_clear`
- `update_pending_draft`
- `clarify`
- `reject`
- `local_only`

Guidance:

- Use `propose_patch` when the user wants to add, remove, or revise specific rules while keeping most existing instructions.
- Use `propose_replace` when the user clearly wants a full new version.
- Use `propose_clear` only when the user clearly wants to remove the current custom instructions.
- If `pendingDraft` exists and the user clearly refers to that draft ("再补一条", "把刚才的草案改一下", "不要清空，改成保留代码规范"), use `update_pending_draft`.
- Natural-language "确认", "应用", or "取消" should not be treated as semantic confirmation. Return `local_only` or `clarify` and let Bridge require `/instructions ok` or `/instructions cancel`.

### `subcommand: "edit"`

Interpret the input as an edit to `pendingDraft`.

Allowed actions:

- `update_pending_draft`
- `clarify`
- `reject`
- `local_only`

Rules:

- If `pendingDraft` is null, return `clarify`.
- Do not silently create a new draft.
- Edit the pending draft, not the live `AGENTS.md`.

## Local-Only Commands

These forms should normally be handled directly by Bridge and not invoke Codex:

- `/instructions`
- `/instructions set <text>`
- `/instructions edit`
- `/instructions clear`
- `/instructions ok`
- `/instructions confirm`
- `/instructions cancel`
- help flags such as `-h`, `--help`, `-help`, `-helps`

If invoked for one of these by mistake:

```json
{
  "schemaVersion": "codexbridge.instructions-command-skill.v1",
  "ok": true,
  "action": "local_only",
  "confidence": 1,
  "requiresConfirmation": false,
  "reason": "This command should be handled by Bridge locally."
}
```

## Safety Boundary

`/instructions` changes a global control file. Be conservative.

Codex must not:

- Write, clear, confirm, cancel, or persist `AGENTS.md` directly.
- Send messages directly or bypass CodexBridge delivery.
- Pretend confirmation has already happened.
- Invent unseen current instructions or pending drafts.
- Turn unrelated code-editing, assistant-record, reminder, or automation requests into `AGENTS.md` edits.

Codex should:

- Preserve important existing rules unless the user clearly asks to remove or replace them.
- Keep the result aligned with the invocation `locale`.
- Return the full proposed `AGENTS.md` content for all mutating draft actions except `propose_clear`.
- Keep the proposal concise and structured.
- When the user asks for relative-language behavior such as "以后更简短", "默认中文", or "发微信时不要带附件", turn that into explicit durable instructions rather than storing vague conversational wording.

## Proposal Schema

For `propose_patch`, `propose_replace`, and `update_pending_draft`, use:

```json
{
  "summary": "short summary",
  "changes": [
    "change 1",
    "change 2"
  ],
  "proposedContent": "full AGENTS.md content"
}
```

Additional rules:

- `summary`: required short string
- `changes`: optional string array; use concise bullet-like items
- `proposedContent`: required full candidate content, except `propose_clear`

For `update_pending_draft`, also include:

```json
{
  "proposalKind": "patch | replace | clear"
}
```

`proposalKind` is required for `update_pending_draft` because the edit may change the pending draft from one proposal type to another.

## Action Schemas

### `propose_patch`

```json
{
  "schemaVersion": "codexbridge.instructions-command-skill.v1",
  "ok": true,
  "action": "propose_patch",
  "confidence": 0.93,
  "requiresConfirmation": true,
  "summary": "在现有指令中新增微信文本回复约束，并收紧回答长度。",
  "changes": [
    "保留现有人格与工程规范",
    "新增默认文本回复规则",
    "补充回答尽量简短"
  ],
  "proposedContent": "# AGENTS.md ... full content ..."
}
```

### `propose_replace`

```json
{
  "schemaVersion": "codexbridge.instructions-command-skill.v1",
  "ok": true,
  "action": "propose_replace",
  "confidence": 0.91,
  "requiresConfirmation": true,
  "summary": "使用新的完整版本替换当前自定义指令。",
  "changes": [
    "整体重写现有指令结构"
  ],
  "proposedContent": "# AGENTS.md ... full replacement content ..."
}
```

### `propose_clear`

```json
{
  "schemaVersion": "codexbridge.instructions-command-skill.v1",
  "ok": true,
  "action": "propose_clear",
  "confidence": 0.95,
  "requiresConfirmation": true,
  "summary": "清空当前自定义指令。",
  "changes": [
    "删除 AGENTS.md 当前内容"
  ]
}
```

### `update_pending_draft`

```json
{
  "schemaVersion": "codexbridge.instructions-command-skill.v1",
  "ok": true,
  "action": "update_pending_draft",
  "confidence": 0.9,
  "requiresConfirmation": true,
  "proposalKind": "patch",
  "summary": "在待确认草案中继续补充微信回复约束。",
  "changes": [
    "保留之前的简短回复要求",
    "补充不主动发送附件"
  ],
  "proposedContent": "# AGENTS.md ... edited pending draft content ..."
}
```

### `clarify`

```json
{
  "schemaVersion": "codexbridge.instructions-command-skill.v1",
  "ok": false,
  "action": "clarify",
  "confidence": 0.41,
  "requiresConfirmation": false,
  "question": "你是要在现有自定义指令上补充规则，还是用一份新的完整内容整体替换？",
  "candidates": [
    { "label": "在现有指令上补充规则" },
    { "label": "整体替换为新的完整内容" }
  ]
}
```

### `reject`

```json
{
  "schemaVersion": "codexbridge.instructions-command-skill.v1",
  "ok": false,
  "action": "reject",
  "confidence": 0.97,
  "requiresConfirmation": false,
  "reason": "这是项目代码或助理记录的修改请求，不是自定义指令请求。"
}
```

## Routing Rules

Prefer these mappings:

- "以后回答我更简短一点" -> `propose_patch`
- "把中文微信回复规则加进去" -> `propose_patch`
- "把 AGENTS 全部换成下面这版" -> `propose_replace`
- "不要任何自定义指令了" -> `propose_clear`
- "把刚才草案里的附件规则去掉" -> `update_pending_draft`
- "确认刚才那个草案" -> `local_only`
- "帮我改 bridge_coordinator.ts" -> `reject`

When uncertain whether the user means "patch" or "replace", prefer `clarify` over guessing.
