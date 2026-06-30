# Mods north star

This directory owns the Letta Code mods runtime. These notes are for contributors changing the mods infrastructure itself, not for agents writing ordinary user mods. User-mod authoring guidance lives in `src/skills/builtin/creating-mods/`.

## Core thesis

Because the interface is the agent, not a human plugin author, mods do not need to start from a strongly versioned semantic SDK. Mods are trusted local code that the agent can inspect, edit, reload, and repair.

The host should expose thin calls only where Letta must preserve runtime invariants: turns, tools, UI, permissions, conversation scoping, persisted state, cancellation, reload, and diagnostics. Everywhere else, prefer ordinary JS/Node code.

The replacement for traditional API stability is recoverability: clear diagnostics, safe mode, reload, and the agent's ability to rewrite broken mod code.

## Design checklist

When adding or changing a mod API, ask these in order:

1. **Why can't this just be code?**
   - If the mod can own the work with `node:fs`, `node:child_process`, `fetch`, local files, or normal JS, do that.
   - Do not add semantic host APIs for convenience alone.

2. **Is this a harness-owned invariant?**
   - Host APIs are justified when the host must coordinate or protect something: tool execution, approvals, turn lifecycle, UI rendering, scoped conversations, cancellation, reload, diagnostics, or backend state.
   - If the host does not need to preserve an invariant, keep the boundary raw.

3. **Has repeated vertical pressure earned an abstraction?**
   - Dogfood real mods first.
   - Prefer one vertical solution over a broad abstraction guessed in advance.
   - Extract a host primitive only after multiple real mods show the same pain.

4. **Does recovery beat compatibility here?**
   - Do not design backwards-compat-first.
   - If an API is wrong, replace it and make the failure easy to diagnose and repair.
   - Migration aids should be temporary and loud, not permanent shims.

5. **Can agents discover and repair the failure?**
   - Prefer explicit diagnostics, precise phases, file paths, owner/capability metadata, and safe-mode escape hatches.
   - Silent fallbacks are worse than loud, recoverable breakage.

## What belongs in host APIs

Good host-owned surfaces:

- registering tools, commands, events, providers, permissions, and panels
- scoped conversation operations like `fork`, `getHistory`, `sendMessageStream`, and model config changes
- event effects that alter harness execution, such as tool result synthesis, turn continuation, or provider-request retry
- diagnostics, stale-handle detection, reload/dispose lifecycle, and safe-mode behavior
- UI primitives where the host owns rendering across TUI/headless/listener surfaces

Usually not host APIs:

- filesystem helpers
- git helpers
- shell/process helpers
- generic storage wrappers
- generic logging wrappers
- package/dependency abstraction before a real package-use case earns it
- provider-specific semantic fields that a mod can parse from raw error/detail data

## Compatibility stance

Mods are agent-authored and agent-maintained. Compatibility is a migration cost, not a guiding design constraint.

Prefer:

- JS feature checks over version matrices
- clean replacements over dual API paths
- diagnostics over silent compatibility behavior
- safe mode over defensive API permanence

Avoid:

- carrying legacy aliases indefinitely
- adding parallel event names just to preserve old semantics
- broad capability matrices that exist mainly to promise stability
- semantic APIs whose only consumer is hypothetical

## Recovery requirements

Kernel-style only works if recovery is strong. Changes in this directory should preserve or improve:

- `--no-mods` / `LETTA_DISABLE_MODS=1`
- disabled mode clearing mod-owned tools, permissions, and providers
- `/reload` invalidating stale activations by generation
- actionable diagnostics with owner, capability, phase, and path
- mod diagnostics written for agent inspection
- no half-enabled behavior when a subsystem is disabled

## Rule of thumb

Default to a low-level trusted-code boundary. Add small, typed host affordances only where the host must coordinate runtime invariants.

If the reason for a new API is "safer for plugin authors" or "better backwards compatibility," stop and re-evaluate. The primary author is the agent, and the product guarantee is repairability, not never breaking.
