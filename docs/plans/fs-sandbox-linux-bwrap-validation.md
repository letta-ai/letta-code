# FS Sandbox — Linux/bubblewrap validation handoff

This is a self-contained task for an agent running on a **Linux** host. Goal:
live-validate the bubblewrap (`bwrap`) backend of the filesystem sandbox, which
is implemented but has **never been run live** — all validation so far is
macOS/Seatbelt.

Work on branch `worktree-fs-sandbox`. The feature is gated behind
`LETTA_FS_SANDBOX=1` and is **default OFF**, so nothing in normal operation
changes; you are exercising it explicitly.

---

## What the feature does (one paragraph)

It kernel-confines an agent's filesystem access so one agent can't read or write
another agent's memory under `~/.letta/agents`. The *parent* agent's shell
commands (the `Bash` tool, Codex `exec_command`/`write_stdin`, Gemini
`run_shell_command`) are each wrapped at spawn with a **cross-agent** policy
(deny the agents tree, carve out the agent's own dir, repo/home/tmp stay
writable). *Subagents* in memory mode are wrapped as a **whole process** with a
**memory-mode** policy (writes scoped to the memory dir; cross-agent reads
denied). When the kernel sandbox is active, the old static "cross-agent guard"
defers to it for shells and skips entirely for sandboxed subagents.

Pure leaf module: `src/sandbox/` (`policy.ts`, `seatbelt.ts`, `bwrap.ts`,
`wrap.ts`, `availability.ts`). The bwrap argv generator is
`src/sandbox/bwrap.ts#buildBwrapArgs`. Backend detection (incl. a real userns
probe) is `src/sandbox/availability.ts#detectSandboxBackend`.

## What is already validated (macOS/Seatbelt) — your job is the Linux mirror

All four live-test scripts pass on darwin/seatbelt. You will run the same
scripts; they auto-detect the backend, so on Linux they exercise bwrap.

## How bwrap differs from Seatbelt — read this before running anything

These differences are exactly where Linux-specific bugs would hide:

1. **No exec-into-target.** `sandbox-exec` *execs into* the target (same PID), so
   a signal to the wrapper hits the shell directly. `bwrap` stays as a **parent**
   of the sandboxed child in a new mount namespace. → **Signal propagation is the
   #1 open question** (task 3).
2. **tmpfs masking, not deny rules.** `buildBwrapArgs` masks each denied root
   with `--tmpfs` (the other agents' dirs become *absent*, not merely
   unreadable — strictly stronger), then re-binds carve-outs on top
   (`--ro-bind` / `--bind`). Root is `--ro-bind / /` (memory mode) or `--bind /
   /` (cross-agent). `--die-with-parent` is set. No `--unshare-net` (network
   stays open).
3. **The empty-env bug may not exist here.** On Seatbelt, a read-deny on a cwd
   *ancestor* makes the child launch with an empty environment; the memory-mode
   policy works around it by carving the whole **agent dir** read-only so the
   cwd's parent stays traversable. bwrap's tmpfs-mask + rebind is *predicted* to
   avoid the problem entirely (the rebind makes the cwd traversable), but this
   is **unverified** — confirm it explicitly (task 2c is the key one).

## Prerequisites

- `bwrap` installed and **unprivileged user namespaces enabled**. Verify:
  ```sh
  bwrap --ro-bind / / --unshare-user /bin/true; echo "userns ok? exit=$?"
  ```
  Must print `exit=0`. If not (WSL1, some hardened/container hosts),
  `detectSandboxBackend()` returns `{backend:null}` and the sandbox is a no-op —
  nothing can be validated. Fix the host first.
- `bun install` in the repo. `bun run check` should be green before you start.

## Validation tasks

### 0. Confirm the backend is detected
```sh
bun -e 'import("@/sandbox/availability").then(m=>console.log(m.detectSandboxBackend({force:true})))'
```
Expect `{ backend: "bwrap", bwrapPath: "bwrap", reason: "bwrap available" }`.
If `backend:null`, stop and fix the host (see prerequisites).

### 1. Run the four live-test scripts
They are already cross-platform (they pick `/bin/bash` on Linux). Each sets up a
throwaway `$HOME`, so they never touch real data. All must pass.

```sh
HOME="$(mktemp -d)" bun scripts/sandbox-bash-live-test.ts
HOME="$(mktemp -d)" bun scripts/sandbox-shell-executors-live-test.ts
HOME="$(mktemp -d)" bun scripts/sandbox-memory-mode-live-test.ts
HOME="$(mktemp -d)" bun scripts/sandbox-composition-live-test.ts
HOME="$(mktemp -d)" SB_NO_GUARD=1 bun scripts/sandbox-composition-live-test.ts
```

Expected, per script:
- **sandbox-bash-live-test** (parent cross-agent): env intact; self/repo/tmp
  writable; another agent's memory read **and** write denied; symlink-escape
  denied; `ls ~/.letta/agents` enumeration denied. On bwrap the denied paths
  will report as *absent* (`No such file or directory`) rather than
  `Operation not permitted` — that is the tmpfs mask and is **fine**; what
  matters is the secret never leaks and the write fails.
- **sandbox-shell-executors-live-test**: `exec_command` pipe, `exec_command`
  PTY, and `shell` all deny the other agent, self reads work. The **PTY case**
  (node-pty inside the bwrap namespace) is the one most likely to surprise — if
  it hangs or errors, capture details.
- **sandbox-memory-mode-live-test** — **THE KEY ONE.** Spawns from the memory-dir
  cwd (inside the masked tree). Must show: `env survives` (this is the empty-env
  check on bwrap), self memory read+write OK, other agent read+write denied,
  writes outside `/memory` denied, broad reads OK.
- **sandbox-composition-live-test**: both-layers and `SB_NO_GUARD=1` (kernel
  only) both end with `✓ composition holds`.

If a script's only failures are string-matching on the macOS error phrase
"operation not permitted" vs the bwrap "No such file or directory", note it but
treat the *security outcome* (no leak / write failed) as the pass criterion, and
adjust the script's matcher to accept both phrases (then re-run).

### 2c. Explicitly confirm env survival on bwrap (subset of task 1, called out)
The memory-mode script already asserts `env survives cwd=memory-dir`. This is the
load-bearing Linux question. If it fails (empty/near-empty env), the bwrap
memory-mode policy needs adjustment (likely an additional `--bind`/`--ro-bind`
of the cwd ancestor chain) — that is a real finding; report it, don't paper over.

### 3. SIGTERM propagation through bwrap (the main open item)
Because bwrap does **not** exec into the target, verify that killing the wrapper
actually kills the inner shell. The real spawn path
(`src/tools/impl/shell-runner.ts`) spawns `detached: true` and kills the process
**group** with `process.kill(-pid, "SIGTERM")`; `bwrap` also has
`--die-with-parent`. Write a small script that mirrors this:

1. Build a wrapped launcher: `wrapLauncher(["/bin/bash","-c","echo $$ > /tmp/sig.pid; sleep 30"], policy, {backend:"bwrap", bwrapPath})` with any cross-agent policy.
2. `spawn(wrapped[0], wrapped.slice(1), { detached: true })`.
3. After the inner PID file appears, `process.kill(-child.pid, "SIGTERM")`.
4. Assert the inner PID is gone within ~2s (`process.kill(innerPid, 0)` throws).

Test both the group-kill path and a plain `child.kill("SIGTERM")` (no negative
PID) to see which bwrap honors. Report which works. If neither reliably kills
the inner shell, that blocks default-on and needs a fix (e.g. ensure bwrap
forwards signals, or rely on `--die-with-parent` + closing stdio).

### 4. Edge checks
- **Network**: a wrapped `bun -e 'fetch("https://api.letta.com/").then(r=>console.log(r.status))'` should connect (no `--unshare-net`).
- **tmpfs mask strength**: inside the cross-agent sandbox, `ls ~/.letta/agents`
  should show *only* the carved agent (others absent), confirming the tmpfs mask.

## Reporting

Report back:
- The `bwrap --version`, kernel (`uname -a`), and distro.
- Pass/fail for tasks 0–4 with the exact script output for any failure.
- The SIGTERM result (which kill path works).
- Whether env survives on bwrap (task 2c) — call this out explicitly.
- Any script matcher changes you made (commit them; keep cross-platform).

## What NOT to do

- Do **not** flip `LETTA_FS_SANDBOX` on by default.
- Do **not** change the Seatbelt path or the policy *model* to make a test pass —
  if bwrap behaves differently, that is a finding to report, and any policy fix
  must keep Seatbelt working.
- Keep the live scripts cross-platform (branch on `process.platform`), don't
  hard-code Linux paths.
