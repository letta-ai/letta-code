# Filesystem Sandbox

OS-level filesystem sandboxing prevents agents sharing one machine from reading
or writing each other's memory.

## Enforcement Surfaces

1. **Shell commands:** wrapped per invocation with cross-agent policy (deny
   active agent-memory tree, carve current agent's own memory back out, leave
   repo/home/tmp writable, network open).
2. **Memory-mode subagents** (reflection, memory, init):
   entire process wrapped. Reads broadly, writes restricted.
3. **In-process file tools** (Read/Edit/Write): cannot fork, so kernel sandbox
   can't see them. Old static cross-agent guard remains: resolves both lexical
   and realpaths to cover symlink escapes.

## Backends

- **Seatbelt (macOS):** `detectSandboxBackend()` must actually probe
  (`sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`), not just check
  file existence. If probe fails, degrade to no-sandbox.
- **bwrap (Linux):** mount namespace, root `--bind / /` for cross-agent mode,
  `--ro-bind / /` for memory mode. Denied roots `--tmpfs` masked.
- **Windows:** C# helper with restricted tokens + temporary ACLs + kill-on-close
  Job Object. Uses `S-1-5-21-*` domain-shaped SIDs (NOT `S-1-15-3-*` capability
  SIDs which fail on standard Windows). `asInvoker` manifest to avoid UAC.

## Cross-Backend Policy

Sandbox policy must deny BOTH memory trees:
- API/cloud: `~/.letta/agents`
- Local backend: `$LETTA_LOCAL_BACKEND_DIR`/memfs

## Environment Variables

- `LETTA_FS_SANDBOX=0` , opt-out everywhere
- `LETTA_SANDBOX=<backend>` , sentinel inside sandboxed children
