# Windows Issues Tracking

## Issue 1: npm install fails (P0)
**Source:** Twitter/@xeon_roam, screenshot shows postinstall failure
**Status:** FIXED

**Root Cause:** `package.json` postinstall script:
```json
"postinstall": "bun scripts/postinstall-patches.js || true"
```
- `bun` - not installed on Windows (users use npm)
- `|| true` - Unix shell syntax, invalid in cmd.exe/PowerShell

**Fix:** Use cross-platform syntax or Node.js directly.

---

## Issue 2: Edit tool fails with line endings (P1)
**Source:** GitHub #322
**Status:** TODO

**Root Cause:** `src/tools/impl/Edit.ts` does direct string matching without normalizing line endings.

Windows files use `\r\n` (CRLF), but the model sends `\n` (LF) in `old_string`. The match fails.

**Fix:** Normalize line endings before comparison, preserve original on write.

---

## Issue 3: Git commits fail - heredoc syntax (P1)
**Source:** GitHub #320, letta/letta#3113
**Status:** TODO

**Root Cause:** System prompt in `src/tools/descriptions/Bash.md` tells model to use heredoc syntax:
```bash
git commit -m "$(cat <<'EOF'
...
EOF
)"
```
This is bash-only syntax that doesn't work in cmd.exe or PowerShell.

**Fix:** Detect Windows in system prompt and use platform-appropriate syntax, or update prompt to use simpler quoting that works cross-platform.

---

## Issue 4: Python/Git not found in PATH (P2)
**Source:** GitHub #321
**Status:** TODO - needs investigation

**Root Cause:** Likely environment variable inheritance issue when spawning shell processes.

User shows Python/Git work in PowerShell directly, but Letta can't find them. Need to investigate how `src/tools/impl/shellLaunchers.ts` inherits PATH.

**Investigation needed:** Check if `spawn()` options include `env: process.env`.
