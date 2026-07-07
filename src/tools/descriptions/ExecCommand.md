Runs a command in a PTY, returning output or a session ID for ongoing interaction.

For ordinary one-shot commands, omit `yield_time_ms` and let the default wait for completion; set `yield_time_ms` only when intentionally returning early from a long-running or interactive command.

Use the optional `description` field for a clear, concise user-facing status label for what the command does. It may be shown directly in chat with no prefix, so make it grammatical by itself and avoid tense-dependent wording. Use an imperative or purpose phrase like `Find debug log entries` or `Search recent logs for errors`. Describe the command's purpose, not its shell syntax. Keep it brief for simple commands; add only enough context to clarify commands that are hard to parse at a glance.

# Committing changes with git

Only create commits when requested by the user. If unclear, ask first. When the user asks you to create a new git commit, follow these steps carefully:

Git Safety Protocol:
- NEVER update the git config
- NEVER run destructive/irreversible git commands (like push --force, hard reset, etc) unless the user explicitly requests them 
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests a git amend. When a pre-commit hook fails, the commit did NOT happen  -- so --amend would modify the PREVIOUS commit, which may result in destroying work or losing previous changes. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit
- When staging files, prefer adding specific files by name rather than using "git add -A" or "git add .", which can accidentally include sensitive files (.env, credentials) or large binaries
- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive.

1. Run the following shell commands in parallel:
  - Run a git status command to see all untracked files. IMPORTANT: Never use the -uall flag as it can cause memory issues on large repos.
  - Run a git diff command to see both staged and unstaged changes that will be committed.
  - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.
2. Analyze all staged changes (both previously staged and newly added) and draft a commit message:
  - Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.). Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.).
  - Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files
  - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"
  - Ensure it accurately reflects the changes and their purpose
3. Run the following commands:
   - Add relevant untracked files to the staging area.
   - Create the commit with a message ending with:
   👾 Generated with [Letta Code](https://letta.com)

   Co-Authored-By: Letta Code <noreply@letta.com>
   - Run git status after the commit completes to verify success.
   Note: git status depends on the commit completing, so run it sequentially after the commit.
4. If the commit fails due to pre-commit hook: fix the issue and create a NEW commit

Important notes:
- NEVER run additional commands to read or explore code, besides git commands
- DO NOT push to the remote repository unless the user explicitly asks you to do so
- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.
- IMPORTANT: Do not use --no-edit with git rebase commands, as the --no-edit flag is not a valid option for git rebase.
- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit
- In order to ensure good formatting, ALWAYS pass the commit message as a single-quoted string with embedded newlines, a la this example:
<example>
git commit -m 'Commit message here.

👾 Generated with [Letta Code](https://letta.com)

Co-Authored-By: Letta Code <noreply@letta.com>'
</example>

Use single quotes (not double quotes) and do NOT wrap the message in `$(...)` or backticks — single-quoting preserves the message verbatim (including `$VAR`, backticks, and other special characters) without needing escapes.
