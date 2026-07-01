# CodexBridge Command Skill: thread search and batch thread actions

## Purpose

This file defines how Codex should normalize natural-language CodexBridge thread commands when Bridge explicitly asks Codex to use this project-local command skill.

Bridge uses this skill for:

1. `/search <natural language>`
2. `/threads <natural language>`
3. `/threads del <natural language>`
4. `/threads restore <natural language>`
5. `/threads pin <natural language>`
6. `/threads unpin <natural language>`

Codex may interpret intent and choose matching threads, but Bridge is the only component allowed to show views, open, peek, rename, archive, restore, pin, unpin, confirm, cancel, or persist any thread change.

Return exactly one JSON object. Do not use Markdown, prose, code fences, tool calls, or side effects.

## Invocation

Bridge sends a prompt with a payload similar to:

```json
{
  "command": "search | threads",
  "subcommand": "search | natural | archive | restore | pin | unpin",
  "rawText": "original user message",
  "userInput": "natural-language part after the slash command",
  "now": "ISO timestamp",
  "locale": "zh-CN",
  "scope": {
    "platform": "weixin",
    "externalScopeId": "..."
  },
  "cwd": "/path/to/repo",
  "threads": [
    {
      "index": 1,
      "threadId": "thread-id",
      "title": "provider title",
      "alias": "local alias",
      "preview": "short preview",
      "updatedAt": "ISO timestamp",
      "archived": false,
      "pinned": true,
      "isCurrent": false
    }
  ],
  "capabilities": {
    "supportedActions": [
      "show_default_threads",
      "show_all_threads",
      "show_pinned_threads",
      "search_threads",
      "open_thread",
      "peek_thread",
      "rename_thread",
      "propose_archive_threads",
      "propose_restore_threads",
      "propose_pin_threads",
      "propose_unpin_threads",
      "clarify",
      "no_match",
      "reject",
      "local_only"
    ],
    "maxResults": 8,
    "supportedManagementOperations": [
      "archive",
      "restore",
      "pin",
      "unpin"
    ]
  },
  "skillPath": "docs/command-skills/threads.md"
}
```

Use only `threads` from the payload as state. Do not invent thread ids, indexes, aliases, titles, or previews.

## Output Contract

Every response must include:

```json
{
  "schemaVersion": "codexbridge.thread-command-skill.v1",
  "ok": true,
  "action": "one_action_name",
  "confidence": 0.9,
  "requiresConfirmation": false
}
```

Use `ok: false` for `clarify` and `reject`. Use confidence from `0` to `1`.

Action summary:

| Action | Purpose | Confirmation |
| --- | --- | --- |
| `show_default_threads` | Show the normal `/threads` view | false |
| `show_all_threads` | Show `/threads all` | false |
| `show_pinned_threads` | Show `/threads pin` pinned-only view | false |
| `search_threads` | Return the best matching threads for `/search` | false |
| `open_thread` | Route `/threads <natural language>` to local open | false |
| `peek_thread` | Route `/threads <natural language>` to local peek | false |
| `rename_thread` | Route `/threads <natural language>` to local rename | false |
| `propose_archive_threads` | Propose a batch archive selection for `/threads del` | true |
| `propose_restore_threads` | Propose a batch restore selection for `/threads restore` | true |
| `propose_pin_threads` | Propose a batch pin selection for `/threads pin` | true |
| `propose_unpin_threads` | Propose a batch unpin selection for `/threads unpin` | true |
| `clarify` | Ask the user to disambiguate | false |
| `no_match` | Say that no good thread match exists | false |
| `reject` | Refuse requests outside this command family | false |
| `local_only` | Tell Bridge this should stay local | false |

## Action Schemas

### `show_default_threads`, `show_all_threads`, `show_pinned_threads`

Use these when `/threads <natural language>` is really a view-selection request.

Examples:

- "看一下线程列表"
- "看全部线程"
- "只看置顶线程"

### `search_threads`

Use this for `/search <text>` or for `/threads <natural language>` when the user is looking for related threads but is not yet asking to open one.

```json
{
  "schemaVersion": "codexbridge.thread-command-skill.v1",
  "ok": true,
  "action": "search_threads",
  "confidence": 0.91,
  "requiresConfirmation": false,
  "summary": "找到和发票跟进最相关的线程。",
  "candidateThreadIds": [
    "thread-1",
    "thread-2"
  ]
}
```

Rules:

- Return the best candidates in ranked order.
- Use only ids from `threads`.
- Prefer semantic relevance over literal token overlap.
- Limit the candidate list to the strongest matches.

### `open_thread` and `peek_thread`

Use these when `/threads <natural language>` clearly asks Bridge to open one thread or preview one thread.

```json
{
  "schemaVersion": "codexbridge.thread-command-skill.v1",
  "ok": true,
  "action": "open_thread",
  "confidence": 0.93,
  "requiresConfirmation": false,
  "summary": "打开昨天那个发票线程。",
  "candidateThreadIds": [
    "thread-1"
  ]
}
```

Rules:

- Return exactly one best thread when confidence is high enough.
- If multiple threads are plausible, use `clarify`.
- `open_thread` now rebinds the current scope and also shows a short recent-turn preview from the opened thread, so users may not need a separate `peek_thread` first.
- Use `peek_thread` when the user says "先看一下", "预览", "peek", or similar wording.

### `rename_thread`

Use this when `/threads <natural language>` clearly asks to rename one thread.

```json
{
  "schemaVersion": "codexbridge.thread-command-skill.v1",
  "ok": true,
  "action": "rename_thread",
  "confidence": 0.9,
  "requiresConfirmation": false,
  "summary": "把目标线程改名为微信桥接排障。",
  "newName": "微信桥接排障",
  "candidateThreadIds": [
    "thread-1"
  ]
}
```

Rules:

- Return exactly one target thread.
- `newName` is required.
- If the target thread is unclear or the new name is missing, use `clarify`.

### `propose_archive_threads`, `propose_restore_threads`, `propose_pin_threads`, `propose_unpin_threads`

Use these for natural-language `/threads` batch management requests, including root `/threads <natural language>` requests that clearly imply archive, restore, pin, or unpin.

```json
{
  "schemaVersion": "codexbridge.thread-command-skill.v1",
  "ok": true,
  "action": "propose_archive_threads",
  "confidence": 0.88,
  "requiresConfirmation": true,
  "summary": "归档旧版登录排障相关线程。",
  "reason": "这些线程都与旧版登录排障有关，且最近没有继续更新。",
  "candidateThreadIds": [
    "thread-3",
    "thread-7"
  ]
}
```

Rules:

- Use only ids from `threads`.
- `summary` is required.
- `reason` is optional but recommended when it helps the user confirm the batch.
- For `archive`, prefer non-archived threads.
- For `restore`, prefer archived threads.
- For `pin`, prefer unpinned threads.
- For `unpin`, prefer pinned threads.
- If the user clearly asks for a destructive or broad batch but the target set is ambiguous, use `clarify`.

### `clarify`

Use this when multiple thread groups are plausible or the request is underspecified.

```json
{
  "schemaVersion": "codexbridge.thread-command-skill.v1",
  "ok": false,
  "action": "clarify",
  "confidence": 0.45,
  "requiresConfirmation": false,
  "question": "你是要处理发票跟进线程，还是处理旧版登录排障线程？",
  "candidates": [
    { "threadId": "thread-1", "label": "发票跟进" },
    { "threadId": "thread-2", "label": "旧版登录排障" }
  ]
}
```

### `no_match`

Use this when the request is valid but nothing in `threads` fits well enough.

```json
{
  "schemaVersion": "codexbridge.thread-command-skill.v1",
  "ok": true,
  "action": "no_match",
  "confidence": 0.86,
  "requiresConfirmation": false,
  "reason": "当前线程目录里没有明显匹配“丹达第四期发票”的会话。"
}
```

### `reject`

Use this when the user is not really asking for thread search or thread batch management.

Examples:

- wants to open a known index directly with `/open 2`
- wants to peek a known index directly with `/peek 1`
- wants to rename a known index directly with `/rename 1 新名字`
- wants to open a known index directly
- wants to rename a thread directly
- wants to inspect message content in depth rather than pick a thread

```json
{
  "schemaVersion": "codexbridge.thread-command-skill.v1",
  "ok": false,
  "action": "reject",
  "confidence": 0.95,
  "requiresConfirmation": false,
  "reason": "这是确定性的线程操作，不应该走自然语言批量路由。"
}
```

### `local_only`

Use this when Bridge should keep handling the command locally.

```json
{
  "schemaVersion": "codexbridge.thread-command-skill.v1",
  "ok": true,
  "action": "local_only",
  "confidence": 1,
  "requiresConfirmation": false,
  "reason": "This command should be handled by Bridge locally."
}
```

## Local-Only Commands

These forms should normally be handled directly by Bridge and not invoke Codex:

- `/threads all`
- `/threads pin` with no extra arguments
- `/threads confirm`
- `/threads ok`
- `/threads cancel`
- `/next`
- `/prev`
- `/open <index|threadId>`
- `/peek <index|threadId>`
- `/rename <index|threadId> <newName>`
- help flags such as `-h`, `--help`, `-help`, `-helps`
- explicit numeric or raw-id management such as `/threads del 2 3` or `/threads pin 1`

If invoked for one of these by mistake, return `local_only`.

## Safety Boundary

Codex must not:

- Open, rename, archive, restore, pin, unpin, confirm, cancel, or persist anything directly.
- Invent thread ids or choose threads outside the provided inventory.
- Treat a vague batch request as already confirmed.
- Turn `/search` into a destructive action.

Codex should:

- Use aliases, titles, previews, update times, archived state, pinned state, and current-thread markers to reason about relevance.
- Prefer a short, high-quality ranked list over a long noisy list.
- Be conservative for mutating actions and ask for clarification when the batch boundary is not clear.
