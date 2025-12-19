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
**Status:** FIXED

**Root Cause:** `src/tools/impl/Edit.ts` does direct string matching without normalizing line endings.

Windows files use `\r\n` (CRLF), but the model sends `\n` (LF) in `old_string`. The match fails.

**Fix:** Normalize file content to LF on read (same approach as Gemini CLI and Codex).
Applied to: Edit.ts, MultiEdit.ts, ApplyPatch.ts

---

## Issue 3: Git commits fail - heredoc syntax (P1)
**Source:** GitHub #320, letta/letta#3113
**Status:** FIXED

**Root Cause:** System prompt in `src/tools/descriptions/Bash.md` tells model to use heredoc syntax:
```bash
git commit -m "$(cat <<'EOF'
...
EOF
)"
```
This is bash-only syntax that doesn't work in cmd.exe or PowerShell.

**Fix:** Added Windows-specific shell guidance to session context (only shown on Windows).
This avoids polluting the prompt for non-Windows users (similar pattern to Gemini CLI).

---

## Issue 4: Python/Git not found in PATH (P2)
**Source:** GitHub #321
**Status:** FIXED

**Root Cause:** We tried cmd.exe first, then PowerShell. Many users configure Python/Git
in their PowerShell environment but not system-wide cmd.exe PATH.

**Fix:** Changed shell order to match Gemini CLI and Codex CLI - PowerShell first, cmd.exe as fallback.
This ensures better PATH compatibility since many tools are configured in PowerShell profiles.
