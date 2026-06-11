# FS Sandbox — Linux/bubblewrap validation handoff

This is a self-contained task for an agent running on a **Linux** host. Goal:
live-validate the bubblewrap (`bwrap`) backend of the filesystem sandbox, which
is implemented but has **never been run live** — all validation so far is
macOS/Seatbelt.

Work on branch `worktree-fs-sandbox`. The feature is gated behind
`LETTA_FS_SANDBOX=1` and is **default OFF**, so nothing in normal operation
changes; you are exercising it explicitly.

---

## STATUS — Linux/bwrap validation COMPLETE (2026-06-10)

Live-validated on Debian 12 (bookworm), kernel 6.1.0, **bwrap 0.8.0**,
unprivileged userns enabled. Tasks 0–4 below all pass, and **two real bugs were
found and fixed**. The bwrap backend is functionally validated end-to-end on
Linux. What remains before default-on is the macOS re-validation of the two
shared-policy fixes — see "Remaining" at the bottom.

**Results**
- **Task 0** — backend detected: `{ backend: "bwrap", reason: "bwrap available" }`.
- **Task 1** — all live scripts pass (after the matcher fixes below): bash
  cross-agent, shell-executors (pipe + **PTY** + shell), memory-mode,
  composition (both layers + `SB_NO_GUARD=1` kernel-only).
- **Task 2c** — env survives on bwrap (cwd = masked memory dir; ~51 keys). The
  predicted tmpfs-mask + rebind avoids the Seatbelt empty-env bug.
- **Task 3** — SIGTERM: **both** the group-kill (`process.kill(-pid)`, the real
  `shell-runner.ts` path) and a plain `child.kill()` reap the inner shell;
  `--die-with-parent` backs it up. No blocker for default-on.
- **Task 4** — network stays open (HTTP 200, no `--unshare-net`); tmpfs mask
  hides other agents (enumeration shows only the carved self).

**Bugs found + fixed**
1. **Memory-mode temp over-grant** — the policy carved `/tmp`/`$TMPDIR`
   writable, which memory mode's static contract (`isScopedMemoryShellCommand`)
   never allowed. On bwrap, when the agents tree lives under a writable root (a
   `/tmp`-based throwaway HOME), the broad `/tmp` carve re-binds over the
   agents-tree tmpfs mask (last-mount-wins) and re-exposes other agents. Dropped
   the temp carve — writes are now scoped to the memory dir only; the wrapped
   bun runtime still launches fine under the read-only root.
2. **bwrap aborts on a missing carve-out root** — `--bind`/`--ro-bind` fail the
   whole spawn when the source is missing, and `resolveAllowedMemoryRoots`
   always lists the lazily-created `memory-worktrees` sibling, so any agent
   without worktrees couldn't spawn a memory subagent. Switched carve-out
   restores to `--bind-try`/`--ro-bind-try` (skip a missing source; fail-closed,
   masks stay strict). Seatbelt was never affected (lexical rules). Caught by the
   new subagent live test.

**Test/script changes**
- Live matchers made cross-platform: accept bwrap's absent-path semantics
  (`No such file or directory`) alongside Seatbelt's `operation not permitted` /
  `read-only file system`; the composition enumerate case accepts the bwrap
  outcome (ls succeeds, mask hides other agents).
- Added `scripts/sandbox-subagent-live-test.ts` — drives the **real**
  `wrapSubagentLauncher` (gating: flag / permissionMode / backendMode) and
  spawns the wrapped child the way `manager.ts` does, asserting gating +
  isolation end-to-end.
- Added `scripts/sandbox-sigterm-live-test.ts` — task 3 as a reproducible
  script: both the group-kill (`process.kill(-pid)`, the `shell-runner.ts` path)
  and a plain `child.kill()` reap the inner shell.
- Documented the **ancestor-carve hazard** inline in `src/sandbox/bwrap.ts`: a
  carve-out that is an *ancestor* of a denied root un-masks it on bwrap
  (last-mount-wins). No current caller does this; the comment guards re-intro.

Commits (branch `worktree-fs-sandbox`): `fix(sandbox): scope memory-mode writes
to the memory dir only`, `fix(sandbox): tolerate not-yet-created carve-out roots
on bwrap`, `test(sandbox): cross-platform live matchers; add subagent-spawn live
test`.

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

---

## Remaining before default-on — macOS re-validation handoff

The two fixes above touch the **shared** policy, not just bwrap: the temp-carve
removal is in `buildMemoryModeSandboxPolicy`, which both backends use. So before
flipping `LETTA_FS_SANDBOX` on by default, on a **Mac/Seatbelt** host:

1. Re-run all four live scripts (they auto-detect Seatbelt) **plus** the new
   `scripts/sandbox-subagent-live-test.ts` and
   `scripts/sandbox-sigterm-live-test.ts`. The memory-mode and subagent scripts
   are the ones the policy change affects — confirm self/parent-memory writes
   still work, writes outside the memory dir are denied, and the Seatbelt
   subagent process still launches now that there is no temp carve.
2. Confirm the temp removal didn't regress the Seatbelt empty-env workaround
   (env should still survive from a memory-dir cwd — it's a separate mechanism,
   but verify explicitly).

Open follow-up (not a blocker for the Seatbelt sign-off): a true end-to-end
subagent spawn through the live agent loop with an LLM round-trip.
`sandbox-subagent-live-test.ts` exercises the real spawn path
(`wrapSubagentLauncher` + the manager's spawn shape) but substitutes a `/bin/bash`
filesystem probe for the agent itself.

---

## DELTA — local-backend sandbox + `~/.letta`-scoped writes (NEEDS bwrap mirror)

Everything above validated the **API/cloud** sandbox on bwrap. After that
sign-off the sandbox was extended to the **local backend** and the memory-mode
write posture changed twice (settling on `~/.letta`-scoped). These commits are
NOT yet bwrap-validated — only darwin/Seatbelt:

- `1eb9affb` cross-agent read-deny → local backend (both surfaces)
- `a18f1e3b` write-scope parity for local memory subagents (intermediate)
- `7963ca22` L5 — real local reflection subagent
- `4c61393d` guard cloud transcript writes
- (final) memory-mode writes scoped to `~/.letta` via `baseWritableRoots`

**What changed (so you know what to stress):** local memory lives under
`~/.letta/lc-local-backend/memfs/<id>/memory`, not `~/.letta/agents`, so both
sandbox surfaces wall off the `memfs` tree when local. Memory subagents (both
backends) are `restrictWrites:true` with **`~/.letta` as the writable base** — a
NEW policy field `baseWritableRoots` emitted BEFORE the denied-root masks. So a
subagent may write anywhere under `~/.letta` (memory + harness state: settings,
logs, conversations, transcripts) but not the repo/home/temp; the cross-agent
tree nested inside `~/.letta` is still masked. `bwrap.ts` binds `baseWritableRoots`
rw right after `--proc`, BEFORE the `--tmpfs` masks. See
`docs/plans/fs-sandbox-local-backend.md`.

### Tasks (bwrap mirror of the Seatbelt validation)

1. **`scripts/sandbox-local-backend-live-test.ts`** (synthetic, both surfaces,
   auto-detects bwrap). Assert: local subagent → other-agent memory read+write
   DENIED, self memory writable, **repo + /tmp writes DENIED** (write-scoping),
   **`~/.letta/.lettasettings` + arbitrary `~/.letta` file writable** (the harness
   base) + conversations/agents/providers/transcript writable, env survives cwd
   inside the masked `memfs` tree. Local parent shell → other-agent denied, self
   memory + repo writable.

2. **`scripts/sandbox-subagent-live-test.ts`** — now has `write transcript root
   (allow)` + `write ~/.letta settings file (allow)` + `write /tmp (DENY)` probes
   on the API path. Confirm on bwrap. Exit-status checks, so backend-agnostic.

3. **bwrap base-bind-BEFORE-mask ordering — THE critical correctness check.**
   `~/.letta` (the base) is now an *ancestor* of the masked `memfs`/`agents` tree.
   This is the exact ancestor-carve hazard from the section above, but used
   DELIBERATELY and safely: the base `--bind ~/.letta` is emitted BEFORE the
   `--tmpfs` mask, so last-mount-wins keeps the nested tree masked. VERIFY on bwrap
   that cross-agent memory is STILL denied with the broad `~/.letta` bind active
   (the `LETTA_SCOPED` unit test in `bwrap.test.ts` asserts the arg order; the live
   test asserts the kernel outcome). A /tmp-based throwaway HOME puts `~/.letta`
   under a writable root — exercise that case explicitly. If the order were ever
   flipped, the broad bind would re-expose every agent's memory.

4. **L5 real runs on a Linux host (spend tokens):**
   - `scripts/sandbox-l5-local-reflection.ts` — `ANTHROPIC_API_KEY` set, `unset
     OPENAI_API_KEY` (gpt-5-mini llm_errors via local pi-ai — use Anthropic).
     Expect reflection child sandboxed (now "via bwrap"), no trap, 2nd agent
     record + memfs commits.
   - `scripts/sandbox-l5-cloud-reflection.ts` — `LETTA_API_KEY` set. Expect
     reflection sandboxed via bwrap, no trap, transcript files persisted.
   - **⚠ trap-detection caveat:** both L5 drivers detect a trap via the regex
     `operation not permitted|EPERM|not permitted` — Seatbelt's wording. On bwrap
     a blocked write surfaces as `Read-only file system` (EROFS) or `No such file
     or directory` (ENOENT), so the regex can MISS a bwrap trap and report a false
     PASS. The local L5's positive check (2nd agent record) still catches a trap;
     the cloud L5's transcript check does NOT (those are parent-written,
     unsandboxed). So on bwrap, lean on synthetic tasks 1–2 (exit-status,
     backend-agnostic) as primary, and consider widening the L5 trap regex to
     include EROFS/ENOENT before trusting its green.

5. **`bun run check` on Linux** — madge/boundaries are platform-agnostic but run
   it to confirm nothing macOS-specific snuck in.

6. SIGTERM propagation (task 3 in the section above) is unchanged and still
   applies — `--die-with-parent` / process-group kill through bwrap.
