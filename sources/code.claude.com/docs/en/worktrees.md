> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Run parallel sessions with worktrees

> Isolate parallel Claude Code sessions in separate git worktrees so changes don't collide. Covers the `--worktree` flag, subagent isolation, `.worktreeinclude`, cleanup, and non-git VCS hooks.

A [git worktree](https://git-scm.com/docs/git-worktree) is a separate working directory with its own files and branch, sharing the same repository history and remote as your main checkout. Running each Claude Code session in its own worktree means edits in one session never touch files in another, so one session can build a feature while a second fixes a bug.

<Note>
  Worktrees require a git repository; for other version control systems, [configure hooks to replace the git logic](#non-git-version-control). In the [desktop app](/docs/en/desktop#work-in-parallel-with-sessions), every new session gets its own worktree automatically.
</Note>

Worktrees are one of several ways to run Claude in parallel. They isolate file edits, while [subagents](/docs/en/sub-agents) and [agent teams](/docs/en/agent-teams) coordinate the work itself. See [Run agents in parallel](/docs/en/agents) to compare the approaches, or skip ahead to [Isolate subagents with worktrees](#isolate-subagents-with-worktrees) to use worktrees and subagents together.

Most sessions need only the first two sections: [start Claude in a worktree](#start-claude-in-a-worktree), then [clean up when you exit](#clean-up-worktrees). Return to the rest of the page when you need to [resume a session](#resume-a-worktree-session), [change how worktrees are created](#customize-worktree-creation), or [debug a failure](#troubleshooting).

## Start Claude in a worktree

Pass `--worktree` or `-w` with a name to create an isolated worktree and start Claude in it. By default, the worktree is created under `.claude/worktrees/<name>/` at your repository root, on a new branch named `worktree-<name>`:

```bash theme={null}
claude --worktree feature-auth
```

Run the command again with a different name in another terminal to start a second isolated session. If you omit the name, Claude generates one such as `bright-running-fox`.

Interactive runs require [workspace trust](/docs/en/security): if you haven't run Claude in the directory before, run `claude` once there to accept the trust dialog, or `--worktree` exits with an error prompting you to. Non-interactive runs with `-p` skip the trust check, so `claude -p --worktree` proceeds without it.

<Tip>
  Add `.claude/worktrees/` to your `.gitignore` so worktree contents don't appear as untracked files in your main checkout.
</Tip>

### Set up the worktree environment

A worktree is a fresh checkout, so initialize your development environment there: ask Claude to install dependencies, or run your project's setup yourself in the worktree directory under `.claude/worktrees/`. To carry gitignored files such as `.env` into every new worktree automatically, add a [`.worktreeinclude` file](#copy-gitignored-files-into-worktrees).

### Ask Claude to create a worktree

You can also ask Claude to "work in a worktree" during a session, and it creates one with the [`EnterWorktree`](/docs/en/tools-reference) tool. Once in a worktree, Claude can switch directly to another one under `.claude/worktrees/` by calling `EnterWorktree` with the target path; the previous worktree stays on disk untouched.

When Claude enters a path outside the repository's `.claude/worktrees/` directory, Claude Code asks for your approval first, because the move takes the session's working directory, write access, and project configuration such as `CLAUDE.md` and settings to that location. An `EnterWorktree` [permission rule](/docs/en/permissions) or choosing "don't ask again" doesn't suppress this prompt; only `bypassPermissions` mode skips it. Before v2.1.206, Claude could enter any existing worktree path without asking.

<Note>
  **Hook paths don't follow the worktree.** After Claude enters a worktree, Claude Code keeps `${CLAUDE_PROJECT_DIR}` in your [hooks](/docs/en/hooks#reference-scripts-by-path) where it was and passes the worktree path to them a different way:

  * **`${CLAUDE_PROJECT_DIR}` stays put**: it still points at the project root where the session started, so a hook command such as `${CLAUDE_PROJECT_DIR}/.claude/hooks/check-style.sh` still runs the script in the main checkout.
  * **`cwd` follows Claude**: the `cwd` field in the hook's [input JSON](/docs/en/hooks#common-input-fields) is the worktree root, and it moves again when Claude runs `cd`. Read it when a hook needs the worktree path.
</Note>

## Clean up worktrees

When you exit an interactive worktree session, Claude checks the worktree for work that removal would delete: changed or untracked files, and new commits.

* **The worktree is clean**: for an unnamed session, Claude removes the worktree and its branch automatically. A [named](/docs/en/sessions#name-your-sessions) session prompts you first so you can keep the worktree for later
* **The worktree has work in it**: Claude prompts you to keep or remove the worktree. Keeping preserves the directory and branch so you can return later. Removing deletes the worktree directory and its branch, along with all the work in them

Non-interactive runs with `-p` have no exit prompt, so Claude doesn't clean up their worktrees, and Claude Code leaves the lock it took on each one at creation in place until a later session's [stale-lock sweep](#clean-up-subagent-and-background-session-worktrees) releases it. To remove one, run `git worktree remove`; if git refuses because the worktree is locked, run `git worktree unlock` on it first.

On Windows, removing a worktree doesn't delete files outside it. If a folder inside the worktree is really a link to somewhere else, such as an NTFS junction or a directory symlink, Claude Code deletes only the link and keeps the folder it points to. Before v2.1.205, removing a worktree with a link nested in a subdirectory could delete the folder it pointed to.

## Resume a worktree session

When you resume a session that was inside a worktree, Claude Code returns the session to that worktree. This holds for interactive resumes, for `--continue` and `--resume` in [non-interactive mode](/docs/en/headless) with `-p`, and for the Agent SDK. Back inside the worktree, Claude can still exit it with the [`ExitWorktree`](/docs/en/tools-reference) tool.

Before returning the session to its worktree, Claude Code verifies that the worktree is still a checkout separate from the main one, and declines to re-enter a worktree that fails the check. For a git worktree, the check reads its git metadata. A worktree without git metadata, such as one a [`WorktreeCreate` hook](#non-git-version-control) created, can pass the check; the cases Claude Code still refuses are listed with their recoveries under [Claude Code refuses to use a worktree](#claude-code-refuses-to-use-a-worktree). For the messages and how to recover from each, see [The session resumes outside its worktree](#the-session-resumes-outside-its-worktree).

Where you launch from, and how you resume, change what Claude Code re-enters:

* **Launch directory**: resume from the main checkout or another directory of the repository. Claude Code re-enters a worktree it created with git under `.claude/worktrees/` even when you launch from inside it. When you launch from inside any other worktree, Claude Code re-enters it only if it can vouch for it from there: a worktree that is its own repository, one without git metadata, or a launch from a subdirectory of a worktree you created with `git worktree add` declines, so launch those from the main checkout.
* **`--fork-session`**: the forked session starts in the directory you launched Claude from, and Claude Code leaves the original session's worktree untouched.
* **Deleted worktree**: if the worktree directory no longer exists, Claude Code resumes the session in the directory you launched Claude from. It tells you the worktree is gone and clears the session's worktree binding.

<Note>
  Before v2.1.212, a non-interactive resume stayed in the starting directory and `ExitWorktree` reported that there was no active worktree session to exit.
</Note>

When Claude enters or exits a worktree that Claude Code created with git, the transcript follows: Claude Code records the session under the session's new working directory, the same way [`/cd`](/docs/en/commands) does, so `/desktop` and `--resume` find it there. Exiting moves it back the same way. A worktree created by a [`WorktreeCreate` hook](#non-git-version-control) keeps its transcript at the launch directory. Requires Claude Code v2.1.198 or later.

## How Claude Code enforces isolation

While a session is isolated in a worktree, Claude Code blocks the tool calls the checks below define. The same rules apply whether you started the session with `--worktree`, Claude entered a worktree with `EnterWorktree`, or you resumed a worktree session.

The same enforcement covers every subagent Claude spawns from the isolated session. It applies whether the session is interactive or runs in the [background](/docs/en/agent-view#how-file-edits-are-isolated). [Subagents that run in their own worktree](#isolate-subagents-with-worktrees) carry the same checks. Their version history is under [Write subagent files](/docs/en/sub-agents#write-subagent-files).

Claude Code applies four checks:

* **File edits**: Claude Code blocks an `Edit`, `Write`, or `NotebookEdit` that targets a path in the main checkout.
* **Command working directory**: Claude Code blocks a Bash, PowerShell, or Monitor command whose working directory resolves to the main checkout, or whose working directory it can't verify stays outside it.
* **Git redirects**: Claude Code blocks a Bash or Monitor command that redirects git into the main checkout. The redirect can come through `git -C`, `--git-dir`, a `GIT_DIR` or `GIT_WORK_TREE` variable, or a `cd` into the main checkout before running git.
* **Command shape**: Claude Code blocks a Bash or Monitor command it can't verify stays inside the worktree, even when the command runs no git at all. Claude Code refuses shell constructs it can't trace without running them, such as brace expansion and heredocs with unquoted delimiters. Claude Code tells Claude how to rewrite the refused command, such as splitting it into plain, separate commands. You can't turn this check off.

The checks apply to the repository you launched Claude Code from. They also cover the main checkout a linked worktree is linked from. For PowerShell commands, Claude Code applies only the working-directory check.

Claude sees each refusal as a tool error that names the worktree and says how to proceed.

## Isolate subagents with worktrees

Subagents can run in their own worktrees so parallel edits don't conflict. Ask Claude to "use worktrees for your agents", or make the isolation permanent for a [custom subagent](/docs/en/sub-agents#supported-frontmatter-fields) by adding `isolation: worktree` to its frontmatter.

This subagent in `.claude/agents/` always runs in its own worktree:

```markdown theme={null}
---
name: refactorer
description: Applies mechanical refactors across many files
isolation: worktree
---

Apply the requested refactor across every affected file, then run the tests
and report the results.
```

Each subagent gets a temporary worktree that Claude Code removes automatically when the subagent finishes without changes; a worktree with changes stays on disk until the [periodic sweep below](#clean-up-subagent-and-background-session-worktrees) can remove it without losing work.

Subagent worktrees use the same [base branch](#choose-the-base-branch) as `--worktree`, so they branch from your repository's default branch unless `worktree.baseRef` is set to `"head"`.

### Clean up subagent and background-session worktrees

Claude Code runs a periodic sweep that removes worktrees that Claude created for subagents and [background sessions](/docs/en/agent-view#how-file-edits-are-isolated) once they are older than your [`cleanupPeriodDays`](/docs/en/settings-reference#cleanupperioddays) setting, following the [retention sweep rules](/docs/en/claude-directory#cleaned-up-automatically).

When you [background](/docs/en/agent-view#send-the-session-to-the-background) a `--worktree` session, its worktree becomes a background-session worktree that the sweep can remove. The sweep leaves a worktree in place in these cases:

* The worktree still holds work: changed or untracked files, or unpushed commits.
* Claude Code can't determine which filter drivers the repository config defines, in any of the [three cases that also block worktree creation](#git-lfs-content-is-missing-from-a-worktree-claude-code-created).
* The worktree belongs to a `--worktree` session you haven't backgrounded, whatever its age.
* You created the worktree yourself with `git worktree add`, even if you then ran a `--worktree <name>` session in it and backgrounded that session.

Claude Code writes a marker into the git metadata of every worktree it creates with git, and the sweep keeps any worktree without one, including a worktree a [`WorktreeCreate` hook](#non-git-version-control) created. Before v2.1.246, the sweep didn't check for the marker, and could remove a worktree you created yourself when an old background-session record pointed at it.

While an agent is running, Claude runs `git worktree lock` on its worktree so that concurrent cleanup cannot remove it. The lock is released when the agent finishes.

The sweep also releases a lock Claude Code set for a session whose process has exited, so a killed background session doesn't leave its worktree permanently locked. The sweep never releases a lock you set yourself with `git worktree lock`. Before v2.1.210, a lock left by a killed session stayed in place until you ran `git worktree unlock`.

To clean up a worktree that the sweep keeps, run `git worktree remove`, adding `--force` if the worktree has uncommitted changes or untracked files.

## Customize worktree creation

Claude Code's defaults for creating worktrees cover most sessions: it creates them under `.claude/worktrees/`, branches them from your repository's default branch, and checks out only tracked files. The options in this section change those defaults.

### Choose the base branch

New worktrees branch from the repository's default branch, so most sessions don't need this setting. Set `worktree.baseRef` in [settings](/docs/en/settings-reference#worktree) to branch from your current work instead. The setting accepts two values:

* `"fresh"` (default): branch from the repository's default branch on the remote, usually `main`, so the worktree starts from a clean tree matching the remote.
* `"head"`: branch from your current local `HEAD`, so the worktree carries your unpushed commits and feature-branch state. Use this when isolating subagents that need to operate on in-progress work. Inside a worktree, `"head"` resolves to that worktree's `HEAD`, not the main checkout's.

You can't set `worktree.baseRef` to a branch name. To start a worktree from a specific existing branch, [create it with git directly](#manage-worktrees-manually).

For a `"fresh"` base, Claude Code keeps `origin/HEAD` current: when the repository hasn't been fetched in the last 24 hours, it fetches the default branch, capped at five seconds, and uses the locally cached ref if the fetch fails. If no remote is configured, or `origin/HEAD` isn't cached locally and can't be fetched, the worktree falls back to your current local `HEAD`. Before v2.1.208, a fresh worktree used whatever `origin/HEAD` was already cached locally.

This example makes every new worktree branch from your current work:

```json theme={null}
{
  "worktree": {
    "baseRef": "head"
  }
}
```

### Branch from a pull request

To branch from a specific pull request or merge request, pass `--worktree` the number prefixed with `#`, a GitHub pull request URL, or a GitLab merge request URL such as `https://gitlab.com/group/repo/-/merge_requests/123`. Claude Code fetches that change's head commit from `origin` and creates the worktree at `.claude/worktrees/pr-<number>`. Quote the argument so your shell doesn't treat `#` as the start of a comment:

```bash theme={null}
claude --worktree "#1234"
```

Claude Code reads only the number from the URL. It always fetches from your repository's `origin` remote, and picks the fetch path by `origin`'s host:

* **github.com**: fetches `pull/<number>/head`
* **gitlab.com**: fetches `merge-requests/<number>/head`
* **GitHub Enterprise, self-managed GitLab, or any other host**: tries `pull/<number>/head` first, then `merge-requests/<number>/head`

Before v2.1.233, Claude Code accepted only `#<number>` and GitHub-style pull request URLs for `--worktree`, and always fetched `pull/<number>/head`.

### Copy gitignored files into worktrees

A worktree is a fresh checkout, so untracked files like `.env` or `.env.local` from your main repository are not present. To copy them automatically when Claude creates a worktree, add a `.worktreeinclude` file to your project root.

The file uses `.gitignore` syntax. Only files that match a pattern and are also gitignored are copied, so tracked files are never duplicated.

If you write a pattern that starts with `**/` and the files you want are inside a directory that is gitignored as a whole, Claude Code copies them only when that directory itself matches the pattern, or when the first name after the `**/` is one of the names in the directory's path. For example, if you write `**/.claude/skills/*.md`, that first name is `.claude`, so Claude Code copies the matching files out of an ignored `.claude/` directory. To copy files out of an ignored directory that a `**/` pattern doesn't reach, name the directory in the pattern instead: write `vendor/**/config.json` rather than `**/config.json`. Before v2.1.239, Claude Code copied files out of a wholly ignored directory for a `**/` pattern only when the directory itself matched the pattern.

This `.worktreeinclude` copies two env files and a secrets config into each new worktree:

```text .worktreeinclude theme={null}
.env
.env.local
config/secrets.json
```

This applies to every worktree Claude Code creates with git: `--worktree` worktrees, [subagent worktrees](#isolate-subagents-with-worktrees), and parallel sessions in the [desktop app](/docs/en/desktop#work-in-parallel-with-sessions). With a [`WorktreeCreate` hook](#non-git-version-control), copy the files inside the hook script.

### Reuse a worktree name

Passing `--worktree` a name whose directory already exists opens that existing worktree instead of creating a new one.

With the default `"fresh"` [base](#choose-the-base-branch), a reopened worktree resets to the repository's default branch instead of continuing at its old tip when all of the following hold:

* It has no uncommitted changes or untracked files.
* It is still on the branch Claude Code created for it.
* It has no commits of its own, or its pull request or merge request was merged and its remote branch deleted.

Claude Code detects the merged case from git state alone: the remote branch the worktree pushed to no longer exists, and every commit in the worktree is already on the default branch.

In every other case, Claude Code reopens the worktree at its old tip:

* The worktree fails any of the conditions.
* Claude Code can't verify the worktree's state.
* `worktree.baseRef` is `"head"`.
* The name is a pull request or merge request reference.

Before v2.1.208, when you reused a name, Claude Code always reopened the old worktree at its old tip.

### Replace worktree creation with a hook

Configure a [`WorktreeCreate` hook](/docs/en/hooks#worktreecreate) to replace the default `git worktree` logic entirely, including placing worktrees somewhere other than `.claude/worktrees/`. For a complete example, see [Non-git version control](#non-git-version-control).

## What worktrees share with the main checkout

A worktree gets its own files and branch, but it shares the repository's `.git` directory, project-scope plugins, and saved permission approvals with the main checkout:

* **The repository's `.git` directory**: git commands in a worktree write to the main repository's shared `.git` directory, and [sandboxing](/docs/en/sandboxing#filesystem-isolation) allows those writes, so commands such as `git commit` work from inside a worktree with the sandbox enabled.
* **Plugins**: plugins installed at [project scope](/docs/en/plugins-reference#plugin-installation-scopes) from the main checkout also load in worktrees of the same repository, so you don't need to reinstall them per worktree. Requires Claude Code v2.1.200 or later.
* **Permission approvals**: choosing "Yes, and don't ask again" for a Bash command in a worktree session saves the rule to the main checkout's `.claude/settings.local.json`, so it applies in the main checkout and in every other worktree of the repository, and it survives the worktree's removal. On Windows and the other cases where Claude Code [keeps the local file in the starting directory](/docs/en/settings#where-claude-code-looks-for-each-file), the rule stays with that worktree. Before v2.1.211, an approval granted in a worktree was saved inside that worktree, didn't apply elsewhere, and was lost when the worktree was removed. See [where approvals are saved](/docs/en/permissions#permission-system).

All three apply whether you create the worktree with `--worktree`, with `git worktree add`, or through the [desktop app](/docs/en/desktop#work-in-parallel-with-sessions).

## Manage worktrees manually

Create worktrees with Git directly when you need to check out a specific existing branch or place the worktree outside the repository.

Create a worktree on a new branch:

```bash theme={null}
git worktree add ../project-feature-a -b feature-a
```

Create a worktree from an existing branch, replacing `fix-issue-456` with a branch that already exists in your repository:

```bash theme={null}
git worktree add ../project-bugfix fix-issue-456
```

Start Claude in the worktree:

```bash theme={null}
cd ../project-feature-a
claude
```

List your worktrees:

```bash theme={null}
git worktree list
```

Remove one when you're done with it:

```bash theme={null}
git worktree remove ../project-feature-a
```

See the [Git worktree documentation](https://git-scm.com/docs/git-worktree) for the full command reference.

## Non-git version control

Worktree isolation uses git by default. For SVN, Perforce, Mercurial, or other systems, configure [`WorktreeCreate` and `WorktreeRemove` hooks](/docs/en/hooks#worktreecreate) to provide custom creation and cleanup logic. Because the hook replaces the default git behavior, [`.worktreeinclude`](#copy-gitignored-files-into-worktrees) is not processed when you use `--worktree`. Copy any local configuration files inside your hook script instead.

This `WorktreeCreate` hook reads the worktree name from the JSON on stdin with `jq`, checks out a fresh SVN working copy, and prints the directory path so Claude Code can use it as the session's working directory. Add the configuration to your [`settings.json`](/docs/en/settings#where-settings-live):

```json theme={null}
{
  "hooks": {
    "WorktreeCreate": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'NAME=$(jq -r .name); DIR=\"$HOME/.claude/worktrees/$NAME\"; svn checkout https://svn.example.com/repo/trunk \"$DIR\" >&2 && echo \"$DIR\"'"
          }
        ]
      }
    ]
  }
}
```

Pair it with a `WorktreeRemove` hook to clean up when the session ends. See the [hooks reference](/docs/en/hooks#worktreecreate) for the input schema and a removal example.

## Troubleshooting

Claude Code reports the errors below when it creates a worktree, enters one at startup, or returns a resumed session to one.

### Claude Code can't enter the worktree at startup

When Claude Code can't enter the worktree directory at startup, it prints an error naming the path and exits with code 1. This can happen when a [`WorktreeCreate` hook](/docs/en/hooks#worktreecreate) prints something other than the directory it created, or when the directory was deleted after it was set up.

### Worktree creation fails on a symlinked path

Claude Code refuses to create a worktree when `.claude`, `.claude/worktrees`, or the worktree directory itself is a symlink, and the error names the symlinked path. Remove the symlink and retry. Before v2.1.212, if the repository already contained a committed symlink at one of those paths, worktree creation followed it and could create files outside the repository.

<h3 id="git-lfs-content-is-missing-from-a-worktree-claude-code-created">
  Git LFS files are pointer files in a worktree Claude Code created
</h3>

If you set up [Git LFS](https://git-lfs.com) with `git lfs install --local`, a worktree that Claude Code creates contains LFS pointer files instead of the real files. The `--local` flag writes the LFS filter into the repository's own `.git/config` rather than your global git config. A plain `git lfs install` writes to your global config and isn't affected. The same applies to any other [filter driver](https://git-scm.com/docs/gitattributes) defined in the repository's own config.

Claude Code skips the repository's own filter drivers when it creates a worktree because a filter driver is a shell command, and anything that can write to the repository, including Claude, could have put one there. Before v2.1.247, Claude Code ran those drivers during worktree creation.

To get the real files, run `git lfs pull` inside the worktree.

In three rare cases, Claude Code can't tell which filter drivers the repository's config defines, and creates no worktree at all. Match the error to its fix:

* **`Could not read the repository git config to neutralize filter drivers`**: Claude Code couldn't read the repository's `.git/config`, for example because of its permissions. Fix that and retry.
* **`The repository git config defines a filter driver whose name cannot be neutralized (contains "=" or a newline)`**: rename or remove that filter driver in `.git/config` and retry.
* **`The repository git config has a conditional include (includeIf)`**: move the settings the `includeIf` in `.git/config` pulls in directly into that file, remove the `includeIf`, and retry. An `includeIf` in your global git config doesn't trigger this.

### Claude Code refuses to use a worktree

An error starting `Refusing to use <path> as an isolation worktree` means Claude Code checked the directory's git identity before adopting it as a session's or subagent's isolated checkout, and declined it. The check runs whether Claude Code is creating the worktree, entering an existing one, or reusing one from an earlier run.

In most cases the rest of the message says the directory's git metadata resolves into the main checkout: for example, its `.git` file points at the main repository's own `.git` directory, or git resolves its working tree to the main checkout through a `core.worktree` redirect. From such a directory, an ordinary git command such as `git reset --hard` would act on the main checkout instead of the worktree. Claude Code also refuses when the directory has a `.git` entry it can't read, rather than assuming the worktree is safe.

Claude Code leaves the refused directory in place, since it may hold work. Match the message to its recovery, whether it follows `Refusing to use <path>` or appears in a [resume message](#the-session-resumes-outside-its-worktree); some endings occur only in resume messages:

* **Says `launch from the parent checkout` or `Run the resume from the project checkout`**: you launched Claude Code from inside the worktree. Launch from the main checkout instead; the worktree needs no recreation.
* **Says `it cannot be resumed or re-entered`**: nothing in this session vouches for the worktree from where you launched. Recreate it; the directory and its work remain on disk for manual recovery, and when the worktree has a parent checkout, resuming from there also works.
* **Says `it contains the protected checkout`**: the refused directory is a parent of your main checkout, such as your home directory. Don't delete it. Change the worktree path, such as the path your `WorktreeCreate` hook returns or the `EnterWorktree` target, so the worktree doesn't contain the checkout.
* **Says `the protected checkout <path> has a .git entry that could not be examined` or `has git metadata that could not be resolved`**: the problem is the main checkout's git metadata, not the worktree's. Don't delete the worktree, and ignore the message's trailing advice to recreate it, which doesn't apply to these two endings. Repair the main checkout, for example a permissions problem or a git `dubious ownership` refusal on its `.git`, and retry.
* **Says `its recorded path has a network spelling`**: Claude Code never resumes into a worktree at a network path. Recreate the worktree at a local path.
* **Any other ending**: the message names the problem and its fix, such as removing a `core.worktree` redirect or recreating the worktree; follow it. Before deleting a directory whose message says its git identity could not be verified, address the named cause first, for example a symbolic link in the worktree's path or git itself failing to run, since the directory may be healthy. When you do recreate, salvage any changes you need from the old directory first; it stays on disk.

### The session resumes outside its worktree

When an interactive resume can't return the session to its worktree, Claude Code says so with one of the messages below.

| Message starts with                               | What happened and what to do                                                                                                                                                                                                                                                                                                                                                                                                                        |
| :------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Your worktree <path> no longer exists`           | The worktree directory was removed. The session continues in the current directory without isolation, and Claude Code clears the worktree binding. No action needed.                                                                                                                                                                                                                                                                                |
| `Could not verify your worktree <path> this time` | Claude Code couldn't verify the worktree, usually for a transient reason; the binding is kept, and the session continues in the current directory without isolation. Resume again to retry; if it keeps happening, enter the worktree in a new session and match the refusal message under [Claude Code refuses to use a worktree](#claude-code-refuses-to-use-a-worktree), which can name the main checkout's metadata rather than the worktree's. |
| `Did not re-enter your worktree <path>`           | Claude Code refused the worktree binding as unsafe; it clears the binding and the session continues without isolation. The message includes the specific refusal: match it under [Claude Code refuses to use a worktree](#claude-code-refuses-to-use-a-worktree), since the fix is recreation for some refusals and a path change for others.                                                                                                       |
| `Could not re-enter your worktree <path>`         | Claude Code couldn't vouch for the worktree from where you launched, most commonly because you launched from inside it; the binding is kept. The rest of the message names the fix; match it under [Claude Code refuses to use a worktree](#claude-code-refuses-to-use-a-worktree).                                                                                                                                                                 |

In [non-interactive mode](/docs/en/headless) with `-p`, and on resumes the [Agent SDK](/docs/en/agent-sdk/sessions) runs, Claude Code stops the resume with a stderr error for every refusal except a gone worktree, instead of continuing without isolation, and the messages take different shapes from the ones in the table above:

* `Error: cannot resume into worktree <path>: ...This session was not started.` for a refusal the table shows as `Did not re-enter`
* `Error: could not verify worktree <path> for this resume, so the resume was aborted...` for `Could not verify`
* `Error: ...The worktree binding is kept.` for `Could not re-enter`
* `Notice: the worktree <path> for this session no longer exists...` for a gone worktree; Claude Code prints it and continues the session, as an interactive resume does

The refusal ending embedded in each error is shared with the interactive notices, so it still matches its entry under [Claude Code refuses to use a worktree](#claude-code-refuses-to-use-a-worktree).

## See also

Worktrees handle file isolation. The related pages below cover delegating work into those isolated checkouts and switching between the sessions you create:

* [Subagents](/docs/en/sub-agents): delegate work to isolated agents within a session
* [Agent teams](/docs/en/agent-teams): coordinate multiple Claude sessions automatically
* [Manage sessions](/docs/en/sessions): name, resume, and switch between conversations
* [Desktop parallel sessions](/docs/en/desktop#work-in-parallel-with-sessions): worktree-backed sessions in the desktop app
