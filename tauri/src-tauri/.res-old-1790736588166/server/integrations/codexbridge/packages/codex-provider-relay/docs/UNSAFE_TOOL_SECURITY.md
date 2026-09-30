# Unsafe Tool Security

`@codex-provider/core` defines contracts for unsafe tools but must not become the default executor for dangerous actions.

Historical names under `@codexbridge/codex-provider-relay` and `CodexProviderRelay*` remain as deprecated aliases during the stabilization cycle.

## Default Policy

- No shell executor is bundled.
- No local computer controller is bundled.
- No code interpreter sandbox is bundled.
- No image provider is bundled.
- No browser automation, desktop automation, credential store, or OS-level control is bundled.
- Relay-emulated unsafe tools require explicit hosted tool declarations and explicit executors.

## Tool-Specific Requirements

### Code Interpreter

OpenAI's Code Interpreter uses a sandboxed container concept. This package only exposes an executor contract. A host that wires `code_interpreter` must own:

- Sandbox selection, such as remote container, Docker, Pyodide, or provider-hosted container.
- CPU, memory, wall-clock, file count, and network limits.
- Input file validation and output file scanning.
- stdout/stderr streaming policy.
- Container lifecycle and cleanup.

### Computer

OpenAI's GA computer tool uses `computer` and returns batched `actions[]`; legacy preview integrations used `computer_use_preview`.

A host that wires `computer` must own:

- Isolated browser or desktop environment.
- Domain and action allow lists.
- Screenshot capture and redaction policy.
- Human approval for purchases, authenticated flows, destructive changes, and irreversible actions.
- Rate limits and emergency stop behavior.

### Shell And Local Shell

Shell-like execution should stay `codex-local-first` unless a host intentionally provides a separate sandboxed executor.

This package should not expose generic shell execution as a convenience API because it changes the trust boundary from protocol relay to machine control.

### Apply Patch

`apply_patch` remains a Codex-local custom tool bridge. The relay translates/proxies tool-call shape but does not apply patches itself.

## Host Checklist

Before enabling an unsafe executor, the host must define:

- Who approves the action.
- Which filesystem roots are writable.
- Whether network access is allowed.
- Which secrets are visible.
- How output is logged and redacted.
- How long execution can run.
- How failures and partial side effects are surfaced.

If the host cannot answer these questions, the tool should remain disabled.
