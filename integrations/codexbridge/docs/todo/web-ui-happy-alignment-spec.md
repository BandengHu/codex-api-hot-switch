# CodexBridge Web UI Happy Alignment Spec

## Goal

Align the current `apps/web` experience with the strongest parts of `reference/happy`
without adopting Happy's Expo/mobile/server architecture.

This spec is scoped to:

- the current Next.js web console in `apps/web`
- Codex-backed sessions first
- chat-first interaction quality
- stable sidebar + stable chat viewport

This spec is **not** a rewrite plan for:

- mobile UI
- encrypted sync
- Happy's backend/server stack
- Expo / React Native Web

## Source References

Key Happy references used for this spec:

- [reference/happy/packages/codium/sources/app/pages/Chat.tsx](/home/ubuntu/dev/CodexBridge/reference/happy/packages/codium/sources/app/pages/Chat.tsx)
- [reference/happy/packages/codium/sources/app/pages/Chat.css](/home/ubuntu/dev/CodexBridge/reference/happy/packages/codium/sources/app/pages/Chat.css)
- [reference/happy/packages/codium/sources/app/components/chat/AssistantMessage.tsx](/home/ubuntu/dev/CodexBridge/reference/happy/packages/codium/sources/app/components/chat/AssistantMessage.tsx)
- [reference/happy/packages/codium/sources/app/components/Composer.tsx](/home/ubuntu/dev/CodexBridge/reference/happy/packages/codium/sources/app/components/Composer.tsx)
- [reference/happy/packages/codium/sources/app/components/SidebarResizer.tsx](/home/ubuntu/dev/CodexBridge/reference/happy/packages/codium/sources/app/components/SidebarResizer.tsx)
- [reference/happy/packages/happy-app/sources/components/ActiveSessionsGroupCompact.tsx](/home/ubuntu/dev/CodexBridge/reference/happy/packages/happy-app/sources/components/ActiveSessionsGroupCompact.tsx)
- [reference/happy/packages/happy-app/sources/components/SidebarView.tsx](/home/ubuntu/dev/CodexBridge/reference/happy/packages/happy-app/sources/components/SidebarView.tsx)
- [reference/happy/docs/layout-core.md](/home/ubuntu/dev/CodexBridge/reference/happy/docs/layout-core.md)

## Current CodexBridge Web State

Current files that own the web chat experience:

- [apps/web/components/codex-sessions-shell.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/codex-sessions-shell.tsx)
- [apps/web/components/session-sidebar.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/session-sidebar.tsx)
- [apps/web/components/codex-thread-messages.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/codex-thread-messages.tsx)
- [apps/web/app/globals.css](/home/ubuntu/dev/CodexBridge/apps/web/app/globals.css)
- [apps/web/lib/server/queries.ts](/home/ubuntu/dev/CodexBridge/apps/web/lib/server/queries.ts)
- [apps/web/server/reply-run-manager.ts](/home/ubuntu/dev/CodexBridge/apps/web/server/reply-run-manager.ts)
- [apps/web/server/reply-executor.ts](/home/ubuntu/dev/CodexBridge/apps/web/server/reply-executor.ts)

The current app already has:

- Codex-backed session list
- real reply sending
- optimistic user message insertion
- SSE-based assistant streaming
- segmented assistant output
- Markdown rendering
- collapsible process panel from commentary

The remaining problems are mostly **interaction shell**, **sidebar stability**,
and **chat surface polish**, not basic backend capability.

## What To Borrow From Happy

### Keep

1. Stable two-panel chat shell
   - left sidebar stays mounted
   - right side swaps content only

2. Chat viewport model
   - one scrollable message viewport
   - fixed composer dock
   - pinned-bottom auto-scroll only while user stays near bottom

3. Process panel placement
   - process/thinking lives under assistant messages
   - default open while streaming
   - collapsible after completion

4. Compact project-grouped sidebar
   - thin project rows
   - hover-only quick actions
   - no heavy card UI

5. Desktop affordances
   - resizable sidebar
   - future-ready three-column direction

### Do Not Borrow

1. Expo / React Native Web component system
2. Happy server / encrypted sync stack
3. Mobile-first app runtime assumptions
4. Happy's broad product scope outside chat, sessions, and layout

## Product Rules

### Rule 1: Sidebar must feel persistent

Switching a session must not visually reload the left column.

Allowed left-sidebar changes on session switch:

- active row background
- active row text/icon emphasis
- unread/active indicators

Disallowed:

- scroll jumping
- group collapsing unintentionally
- row height shifting
- hover actions sticking open after navigation
- full sidebar remount feeling

### Rule 2: Chat is bottom-anchored

When entering a session:

- show the latest visible messages
- land at the bottom
- keep the composer fixed at the bottom

Scrolling upward should load older history.
Opening a session should never feel like opening a document page.

### Rule 3: Web is not WeChat

Do not carry over:

- send throttling
- preview chunk scheduling
- delayed delivery pacing
- send retry UX designed for personal WeChat constraints

Web should use:

- optimistic local user messages
- one assistant draft stream
- progressive finalized assistant message segments
- immediate UI response

### Rule 4: Raw internal context never enters visible chat

Do not render:

- `<environment_context>`
- prompt wrappers
- internal execution envelopes
- raw reasoning deltas

Visible chat should contain only:

- user-visible user messages
- user-visible assistant messages
- productized process/status summaries

## Required Changes

## P0: Shell Stability

### P0.1 Shared sessions layout

Current issue:

- `/sessions` and `/sessions/codex/[threadId]` still behave too much like page swaps.
- Sidebar state is partially restored manually instead of being structurally persistent.

Required change:

- Move the sessions shell into a shared route layout so the sidebar remains mounted across thread switches.

Primary files:

- [apps/web/app/sessions/page.tsx](/home/ubuntu/dev/CodexBridge/apps/web/app/sessions/page.tsx)
- [apps/web/app/sessions/codex/[threadId]/page.tsx](/home/ubuntu/dev/CodexBridge/apps/web/app/sessions/codex/%5BthreadId%5D/page.tsx)
- new `apps/web/app/sessions/layout.tsx`
- [apps/web/components/codex-sessions-shell.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/codex-sessions-shell.tsx)

Acceptance:

- switching sessions does not remount the sidebar
- left scroll position remains stable without manual correction hacks
- hover/open menus do not flicker on route changes

### P0.2 Sidebar row stability

Current issue:

- session rows can visually jump on first navigation
- hover controls and selection states are too tightly coupled to row layout

Required change:

- make each session row fixed-height
- reserve action-slot width even when hover actions are hidden
- show actions with opacity, not layout insertion

Primary files:

- [apps/web/components/session-sidebar.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/session-sidebar.tsx)
- [apps/web/app/globals.css](/home/ubuntu/dev/CodexBridge/apps/web/app/globals.css)

Acceptance:

- hover adds no horizontal reflow
- first click on a session produces no sidebar jitter
- inactive rows do not change height when hovered

## P1: Chat Surface Alignment

### P1.1 True pinned-bottom behavior

Current issue:

- the current chat surface is improved, but not yet as stable as Happy's pinned viewport model

Required change:

- track whether the user is pinned near the bottom
- auto-scroll only while pinned
- preserve manual reading position when new assistant deltas arrive

Primary files:

- [apps/web/components/codex-thread-messages.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/codex-thread-messages.tsx)
- [apps/web/components/codex-sessions-shell.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/codex-sessions-shell.tsx)

Acceptance:

- new assistant output follows the viewport only if the user is already near the bottom
- if the user scrolls up, incoming deltas do not yank the viewport down

### P1.2 Older-history prepend without scroll jump

Current issue:

- loading older messages can still risk visual jump because prepend compensation is not the main interaction design

Required change:

- before prepending older messages, record viewport height/scroll offset
- after prepend, restore equivalent visual position

Primary files:

- [apps/web/components/codex-thread-messages.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/codex-thread-messages.tsx)

Acceptance:

- scrolling upward to fetch older history does not jump the visible window

### P1.3 Composer simplification

Current target:

- one text area
- one send button
- fixed dock
- no fake voice or mode controls in the main composer

Required change:

- keep the current arrow-send model
- remove any leftover fake transport-era affordances from the main chat path
- tighten spacing to match a cleaner chat dock

Primary files:

- [apps/web/components/codex-sessions-shell.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/codex-sessions-shell.tsx)
- [apps/web/app/globals.css](/home/ubuntu/dev/CodexBridge/apps/web/app/globals.css)

Acceptance:

- composer reads as a chat tool, not a control panel
- right-side action area only owns send

## P2: Message Rendering Quality

### P2.1 Assistant message density

Current issue:

- assistant content is functional but still visually heavier than needed

Required change:

- reduce card feel
- let assistant messages read more like chat prose
- keep user bubbles distinct and right-aligned

Primary files:

- [apps/web/components/codex-thread-messages.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/codex-thread-messages.tsx)
- [apps/web/app/globals.css](/home/ubuntu/dev/CodexBridge/apps/web/app/globals.css)

Acceptance:

- assistant output looks like conversational text flow
- user messages remain visually separable

### P2.2 Markdown polish

Current issue:

- Markdown is rendered, but still needs product-level polish

Required change:

- improve spacing and typography for:
  - headings
  - lists
  - blockquotes
  - code blocks
  - tables
- add code-block overflow handling and optional copy affordance later

Primary files:

- [apps/web/components/codex-thread-messages.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/codex-thread-messages.tsx)
- [apps/web/app/globals.css](/home/ubuntu/dev/CodexBridge/apps/web/app/globals.css)

Acceptance:

- Markdown reads like a polished chat client, not raw rendered HTML

### P2.3 Process panel refinement

Current issue:

- process panel exists, but should feel more integrated with the assistant message

Required change:

- keep it below assistant content
- default open while actively streaming commentary
- collapse affordance becomes lighter after completion
- process label should read like product language, not debug language

Primary files:

- [apps/web/components/codex-thread-messages.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/codex-thread-messages.tsx)
- [apps/web/components/codex-sessions-shell.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/codex-sessions-shell.tsx)
- [apps/web/app/globals.css](/home/ubuntu/dev/CodexBridge/apps/web/app/globals.css)

Acceptance:

- process panel feels optional and lightweight
- final answer remains the main focus

## P3: Sidebar Productization

### P3.1 Project row actions

Required change:

- hover-only actions remain vertically centered
- no extra chevrons for expand/collapse
- action affordances never show when not hovered, except on touch/mobile fallback

Primary files:

- [apps/web/components/session-sidebar.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/session-sidebar.tsx)
- [apps/web/app/globals.css](/home/ubuntu/dev/CodexBridge/apps/web/app/globals.css)

Acceptance:

- project rows feel lightweight
- hover actions do not visually pollute idle state

### P3.2 Folder menu semantics

Current expected menu:

- 置顶
- 重命名
- 归档
- 移除

Required change:

- treat these as folder/group actions, not chat-row actions
- ensure their side effects update UI immediately without requiring route churn

Primary files:

- [apps/web/components/session-sidebar.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/session-sidebar.tsx)
- related route handlers in `apps/web/app/api/...`

Acceptance:

- menu actions feel local and instant

### P3.3 Desktop resizable sidebar

Borrow from Happy:

- draggable sidebar width
- stable min/max width

Required change:

- add a desktop-only resize handle between sidebar and main content
- persist width locally

Primary files:

- new `apps/web/components/sidebar-resizer.tsx`
- [apps/web/components/workspace-shell.tsx](/home/ubuntu/dev/CodexBridge/apps/web/components/workspace-shell.tsx)
- [apps/web/app/globals.css](/home/ubuntu/dev/CodexBridge/apps/web/app/globals.css)

Acceptance:

- desktop users can widen or narrow the sidebar without layout breakage

## P4: Future Three-Column Direction

This is not a current implementation requirement, but the layout should not block it.

Future target:

- left: sessions/projects
- center: chat
- right: changed files / all files / context

Do now:

- keep the main shell flexible enough for a future right panel
- avoid hard-coding chat to full remaining width assumptions

Primary reference:

- [reference/happy/docs/layout-core.md](/home/ubuntu/dev/CodexBridge/reference/happy/docs/layout-core.md)

## Implementation Order

Recommended order:

1. shared `/sessions` layout
2. sidebar row stabilization
3. pinned-bottom viewport logic
4. older-history prepend stability
5. assistant message density + Markdown polish
6. process panel refinement
7. desktop sidebar resize
8. future right-panel preparation

## Non-Goals

Do not do these in this workstream:

- rewrite the app around Happy's runtime
- replace Next.js with Expo/React Native Web
- add mobile-native feature parity
- expose raw reasoning or raw execution trace in visible chat
- reintroduce WeChat delivery constraints into Web

## Definition of Done

This spec is considered satisfied when:

1. Clicking a session only changes the right side and active highlight.
2. Sidebar scroll and layout stay stable during navigation.
3. Opening a session lands at the newest visible messages.
4. The composer is fixed at the bottom and always feels interactive.
5. Assistant streaming feels conversational, not like a document repaint.
6. Process information is visible but secondary.
7. Sidebar actions are light, hover-only, and do not change layout.
8. The shell is ready for a future right-side context panel.
