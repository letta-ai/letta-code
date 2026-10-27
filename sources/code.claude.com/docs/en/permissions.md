> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Configure permissions

> Control what Claude Code can access and do with fine-grained permission rules, modes, and managed policies.

Claude Code supports fine-grained permissions so that you can specify exactly what the agent is allowed to do and what it can't. You can check permission settings into version control to share them with every developer in your organization, and each developer can customize their own.

## Permission system

Claude Code uses a tiered permission system to balance power and safety. The table shows, for each tool type, whether Manual mode asks before the action runs. The other [permission modes](#permission-modes) change which of these ask you; in auto mode a classifier reviews actions instead of you, and [how the classifier evaluates actions](https://code.claude.com/docs/en/permission-modes.md#how-the-classifier-evaluates-actions) lists which ones it sees.

| Tool type | Example | Approval required | "Yes, and don't ask again" behavior |
| :- | :- | :- | :- |
| Read-only | File reads, Grep | No, within the [working directory and additional directories](#working-directories) | N/A |
| Bash commands | Shell execution | Yes, except a built-in set of [read-only commands](#read-only-commands) | Permanently per repository and command |
| File modification | Edit/write files | Yes | Until session end |
| Web fetch | WebFetch | Yes, except a built-in set of [preapproved documentation domains](https://code.claude.com/docs/en/tools-reference.md#webfetch-tool-behavior) | Permanently per repository and domain |
| Web search | WebSearch | Yes | Permanently per repository |

A permission prompt shows what Claude is about to do, followed by your options. This example is the prompt for a Bash command, from a session in Manual mode:

![A Claude Code permission prompt titled Bash command. Under a tip about auto mode, it shows the description 'Run the test suite', the command npm test, and the line 'This command requires approval', then asks 'Do you want to proceed?' with four options: Yes; Yes, and don't ask again for: npm test \*; Yes, and switch to auto mode; and No. A footer lists two keys: Esc to cancel and Tab to amend.](https://mintcdn.com/claude-code/oa7CKjMeIChox26S/images/permission-prompt-bash-light.png?fit=max\&auto=format\&n=oa7CKjMeIChox26S\&q=85\&s=87585d008a29304873466399f7b476f6)

The third option, **Yes, and switch to auto mode**, [doesn't appear on every prompt](https://code.claude.com/docs/en/permission-modes.md#switch-permission-modes).

When you choose "Yes, and don't ask again" and the approval saves permanently, such as for a Bash command or a WebFetch domain, Claude Code saves the rule to `.claude/settings.local.json` at the root of the git repository, resolved through [worktrees](https://code.claude.com/docs/en/worktrees.md) to the main checkout. The rule applies to future sessions anywhere in that repository, including sessions started in subdirectories and in worktrees. A file-modification approval isn't saved to the file: as the table shows, it lasts until the session ends. In some cases, such as outside a git repository or on Windows, Claude Code doesn't use the repository root; [Where Claude Code looks for each file](https://code.claude.com/docs/en/settings.md#where-claude-code-looks-for-each-file) lists those cases and where it saves the rule instead.

Before v2.1.211, Claude Code always saved the rule in the starting directory, so an approval granted in a worktree or subdirectory didn't apply to the rest of the repository. Rules that earlier versions saved in a subdirectory or worktree still apply to sessions started there.

Sometimes a permission prompt offers only a one-time approval, with no "don't ask again" option and no option to allow the action for the rest of the session. Claude Code offers those options only when the prompt can show you everything they would allow, so a rule you save from a prompt covers only what its option named. When a prompt offers only the one-time approval, approve the action once, or add the rule yourself in [`/permissions`](#manage-permissions). To stop the prompts for a command that starts with an exec wrapper such as `watch`, or for a `find` command with an action such as `-delete`, see [Exec wrappers and `find` actions](#exec-wrappers-and-find-actions).

### Add a comment when you answer a permission prompt

You can attach a note to Claude when you approve or deny a single action. On most permission prompts, including Bash, PowerShell, file, and MCP tool prompts, move to **Yes** or **No** and press `Tab` to open a comment field on that option. WebFetch and browser prompts don't offer the field. The options that allow the action for the rest of the session or save a rule don't take one either.

With the field open, type the comment and then press one of these keys:

* `Enter`: submits your answer with the comment attached. If you leave the field empty, Claude Code submits the answer without a comment.
* `Tab`: closes the field without answering. Claude Code keeps the text you typed and still sends it if you answer with that option.
* `Shift+Tab`: on a file prompt, such as an Edit or Write prompt, closes the field the same as `Tab`. Before v2.1.235, pressing `Shift+Tab` inside the field instead selected the option that allows the action for the rest of the session, so Claude Code approved the action for the rest of the session and discarded the comment.

Claude Code delivers the comment differently depending on how you answered:

* **Yes**: Claude Code runs the action, then sends your comment to Claude after the result.
* **No**: Claude Code sends your comment to Claude as the reason for the denial, and Claude continues working. If you select **No** without a comment on a prompt from the main conversation, Claude Code stops the turn.

## Manage permissions

You can view and manage Claude Code's tool permissions with `/permissions`. The dialog lists all permission rules and the `settings.json` file each rule comes from. You can open the dialog while Claude is working: when you add or remove a rule, Claude Code applies the change starting with Claude's next tool call in the same turn. Before v2.1.234, Claude Code queued the command until the turn finished.

* **Allow** rules let Claude Code use the specified tool without manual approval.
* **Ask** rules prompt for confirmation whenever Claude Code tries to use the specified tool.
* **Deny** rules prevent Claude Code from using the specified tool.

Rules are evaluated in order: deny, then ask, then allow. The first match in that order determines the outcome, and rule specificity doesn't change the order.

A broad deny rule like `Bash(aws *)` blocks every matching call, including calls that also match a narrower allow rule like `Bash(aws s3 ls)`. An allow rule can't carve an exception out of a deny rule. The same precedence applies between ask and allow: a matching ask rule prompts even when a more specific allow rule also matches the same call.

Deny rules behave differently depending on whether they name a tool or scope a pattern within one. A bare tool name like `Bash` removes the tool from Claude's context entirely, so Claude never sees it. If you add such a rule mid-session, Claude can't call the tool from its next tool call on; [Denying an entire tool](https://code.claude.com/docs/en/prompt-caching.md#denying-an-entire-tool) covers what happens to a definition Claude has already seen. A scoped rule like `Bash(rm *)` leaves the tool available and blocks matching calls when Claude attempts them.

Bare-name removal applies to every tool except [`EndConversation`](https://code.claude.com/docs/en/tools-reference#endconversation-tool-behavior): a deny rule can't remove it while any other tool remains, and an ask rule never prompts for it.

> [!NOTE]
>
> Permission rules are enforced by Claude Code, not by the model. Instructions in your prompt or `CLAUDE.md` shape what Claude tries to do, but they don't change what Claude Code allows. To grant or revoke access, use `/permissions`, the rules described here, a [permission mode](https://code.claude.com/docs/en/permission-modes.md), or a [PreToolUse hook](#extend-permissions-with-hooks).

When [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode) is available to your session, the dialog also includes the [auto mode classifier rules](https://code.claude.com/docs/en/auto-mode-config.md#edit-rules-from-permissions). Select the **Auto mode** tab to view them.

## Permission modes

Claude Code supports several permission modes that control how it approves tool calls. See [Permission modes](https://code.claude.com/docs/en/permission-modes.md) for when to use each one. To change the mode sessions start in, set `defaultMode` in your [settings files](https://code.claude.com/docs/en/settings.md#where-settings-live). [Which mode a session starts in](https://code.claude.com/docs/en/permission-modes.md#which-mode-a-session-starts-in) covers the built-in default for each plan and what the VS Code extension reads.

| Mode | Description |
| :- | :- |
| `default` | Prompts for permission on first use of each tool. Labeled Manual in the CLI, the VS Code and JetBrains extensions, and the desktop app, and Claude Code accepts `manual` as an alias |
| `acceptEdits` | Automatically accepts file edits and common filesystem commands such as `mkdir`, `touch`, `mv`, and `cp` for paths in the working directory or `additionalDirectories` |
| `plan` | Claude reads files and runs read-only shell commands to explore but doesn't edit your source files; with [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode) available, classifier-approved commands also run. Labeled Plan in the CLI and the VS Code extension |
| `auto` | Runs without routine prompts; before actions such as shell commands and network requests run, a background [classifier](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode) checks that they align with your request |
| `dontAsk` | Auto-denies every call that would otherwise prompt, though a [mod](https://code.claude.com/docs/en/plugins/mods/overview.md) you installed can still approve some of those calls. File reads in your working directories and other actions that need no approval still run, as do tools pre-approved via `/permissions` or `permissions.allow` rules. `AskUserQuestion`, MCP tools marked [`requiresUserInteraction`](https://code.claude.com/docs/en/mcp#require-approval-for-a-specific-tool), [reads from network paths](#network-paths), and connector tools [your organization set to `ask`](https://code.claude.com/docs/en/mcp#organization-controls-on-connector-tools) in sessions where that setting reaches Claude Code are denied even if you've allowed them |
| `bypassPermissions` | Skips permission prompts, except for the [actions no mode auto-approves](https://code.claude.com/docs/en/permission-modes.md#actions-no-mode-auto-approves) |

> [!WARNING]
>
> In `bypassPermissions` mode, Claude Code skips permission prompts, including for writes to [protected paths](https://code.claude.com/docs/en/permission-modes.md#protected-paths) such as `.git` and `.claude`. The [cross-session messaging safeguards](https://code.claude.com/docs/en/permission-modes.md#skip-all-checks-with-bypasspermissions-mode) still apply. Only use this mode in isolated environments like containers or VMs where Claude Code can't cause damage.

To prevent `bypassPermissions` or `auto` mode from being used, set `permissions.disableBypassPermissionsMode` or `permissions.disableAutoMode` to `"disable"` in any [settings file](https://code.claude.com/docs/en/settings.md#where-settings-live). These are most useful in [managed settings](#managed-settings) where they can't be overridden.

## Permission rule syntax

Permission rules follow the format `Tool` or `Tool(specifier)`. Parentheses inside the specifier are literal, so a command or path that contains them needs no escaping.

### Match all uses of a tool

To match all uses of a tool, use only the tool name without parentheses:

| Rule | Effect |
| :- | :- |
| `Bash` | Matches all Bash commands |
| `WebFetch` | Matches all web fetch requests |
| `Read` | Matches all file reads |

`Bash(*)` is equivalent to `Bash` and matches all Bash commands. As a deny rule, both forms remove the tool from Claude's context.

The label shown for a tool in the transcript and permission dialog can differ from its canonical name. For example, the tool labeled `Stop Task` in the transcript has the canonical name `TaskStop`. Permission rules and [hook matchers](https://code.claude.com/docs/en/hooks.md) don't match the label, so a rule written as `Stop Task` doesn't match. For deny and ask rules, a [startup warning](https://code.claude.com/docs/en/errors.md#matches-no-tool) says so. Use the canonical names listed in the [tools reference](https://code.claude.com/docs/en/tools-reference.md).

### Use specifiers for fine-grained control

Add a specifier in parentheses to match specific tool uses:

| Rule | Effect |
| :- | :- |
| `Bash(npm run build)` | Matches the exact command `npm run build` |
| `Read(./.env)` | Matches reading the `.env` file in the current directory |
| `WebFetch(domain:example.com)` | Matches fetch requests to example.com |

### Match by input parameter

Deny and ask rules can match a top-level input parameter on any built-in tool with `Tool(param:value)`.

To match a parameter on an MCP tool, pass a deny rule with [`--disallowedTools`](https://code.claude.com/docs/en/cli-reference#cli-flags). When Claude Code loads a settings file, it skips any `mcp__` rule that has parentheses. Claude Code lists the skipped rule in the invalid-settings dialog when an interactive session starts, and in [`claude doctor`](https://code.claude.com/docs/en/debug-your-config#check-resolved-settings) output.

A parameter rule matches when Claude calls the tool with that parameter set to that exact value. An allow rule for one parameter value wouldn't establish that the call is safe overall, so allow rules continue to use each tool's own specifier syntax. This works for any scalar parameter the tool accepts:

| Rule | Matches |
| :- | :- |
| `Agent(model:opus)` | Agent calls that request the Opus model tier |
| `Agent(isolation:worktree)` | Agent calls that request a git worktree |
| `Bash(run_in_background:true)` | Bash calls that run in the background |

Parameter matching follows these rules:

* The parameter name must be a direct field of the tool's input, such as `model` on the Agent tool. Fields nested inside an object or array are not matchable
* Each rule names one parameter. To gate on both `model` and `isolation`, write two rules, `Agent(model:opus)` and `Agent(isolation:worktree)`, rather than combining them in one rule
* The value supports `*` as a wildcard that matches any sequence of characters, so `Agent(isolation:*)` matches any explicit isolation value. Without `*` the match is exact
* A parameter the model omits is never matched, so `Agent(model:*)` doesn't match a call that leaves `model` unset
* The value is compared against the literal input Claude sends, before any normalization. `Agent(model:opus)` matches the alias `opus` but not a full model ID
* A `Skill(skill:<name>)` deny rule instead [matches the skill under any of its names](https://code.claude.com/docs/en/skills.md#restrict-claude’s-skill-access), such as its alias or display name
* Run with [`--verbose`](https://code.claude.com/docs/en/cli-reference) to see the exact parameter names and values in each tool call
* Whitespace around the colon is ignored

You can't match a tool's primary content field this way: `command` for Bash and PowerShell, `file_path` for Read, Edit, and Write, `path` for Grep and Glob, `notebook_path` for NotebookEdit, and `url` for WebFetch. A rule like `Bash(command:rm *)` would be bypassable by a compound command, so Claude Code ignores it and emits a startup warning. Use `Bash(rm *)`, `Read(./path)`, or `WebFetch(domain:host)` instead.

### Wildcard patterns

A `*` in a Bash rule matches any text, including spaces, so one rule covers a family of commands. A rule with no `*` matches one exact command.

> [!WARNING]
>
> Put the `*` after the subcommand. In `git log --oneline main`, `git` is the program and `log` is the subcommand, the word that determines what the program does. Claude Code matches everything before the first `*` as written, so those words are what limit the rule: `Bash(git log *)` allows only `git log` commands, and `Bash(git *)` allows every git command. Claude Code [warns at startup](https://code.claude.com/docs/en/errors.md#has-a-wildcard-before-the-rest-of-the-command) about an allow rule with a `*` before the subcommand, such as `Bash(git * main)`.

Write the command you want Claude to run without asking, and replace the parts that vary with `*`. With this configuration, Claude Code runs npm scripts and git commits without asking and refuses commands that begin with `git push`. A push written another way, such as `git -C . push`, isn't matched; see [what a Bash rule doesn't match](#bash-rule-limits).

```json theme={null}
{
  "permissions": {
    "allow": [
      "Bash(npm run *)",
      "Bash(git commit *)"
    ],
    "deny": [
      "Bash(git push *)"
    ]
  }
}
```

A `*` can go anywhere in the rule: at the start, in the middle, or at the end. Each row shows a rule, commands it matches, and nearby commands it doesn't match:

| You write | Matches | Doesn't match |
| :- | :- | :- |
| `Bash(npm run build)` | `npm run build` | `npm run build --watch` |
| `Bash(npm run *)` | `npm run build`, `npm run test --watch`, `npm run` | `npm install` |
| `Bash(git log * main)` | `git log --oneline main`, `git log -5 main`, `git log --output=<file> main` | `git log main`, `git push origin main` |
| `Bash(git * main)` | `git merge main`, `git push origin main`, `git -c core.fsmonitor=<script> diff main` | `git log` |
| `Bash(* --version)` | `node --version`, `bash -c 'echo hi' --version` | `node -v` |
| `Bash(ls *)` | `ls -la`, `ls` | `lsof` |
| `Bash(ls*)` | `ls -la`, `lsof` | |
| `Bash(* --help *)` | `npm --help x` | `npm --help` |

Three matching rules produce those rows:

* **The `*` stands in for whatever text is in its place.** In `Bash(git * main)`, it stands in for the subcommand, so Claude Code matches every git subcommand and every option before it. That includes `-c`, which makes git run a program you name. In `Bash(* --version)`, the `*` stands in for the program, so any program matches.
* **A `*` at the end, with a space before it, also matches the bare command.** `Bash(ls *)` matches `ls`, and `Bash(git log *)` matches `git log`. That holds only when the trailing `*` is the rule's only wildcard: `Bash(* --help *)` matches `npm --help x` but not `npm --help`.
* **The space before a trailing `*` is part of the rule.** `Bash(ls *)` requires a space after `ls`, so `lsof` doesn't match. `Bash(ls*)` has no space, so it matches `lsof` too.

The `:*` suffix is an equivalent way to write a trailing wildcard, so `Bash(ls:*)` matches the same commands as `Bash(ls *)`.

The permission dialog writes the space-separated form when you select "Yes, and don't ask again" for a command prefix. The `:*` form is only recognized at the end of a pattern. In a pattern like `Bash(git:* push)`, the colon is treated as a literal character and won't match git commands.

### Tool name wildcards

Deny and ask rules also accept glob patterns in the tool-name position. The pattern must match the full tool name: `"*"` matches every tool, and `"mcp__*"` matches every MCP tool across all servers. A tool matched by a bare-name glob deny rule is removed from Claude's context, the same as a bare tool name, including the [`EndConversation`](https://code.claude.com/docs/en/tools-reference#endconversation-tool-behavior) exception: a glob deny can't remove it while any other tool remains, and a glob ask never prompts for it. This configuration denies every MCP tool:

```json theme={null}
{
  "permissions": {
    "deny": [
      "mcp__*"
    ]
  }
}
```

Allow rules accept tool-name globs only after a literal `mcp__<server>__` prefix. The server segment must be glob-free so the rule names a specific server you configured. `mcp__puppeteer__*` matches every tool from the `puppeteer` server, and `mcp__github__get_*` matches its `get_` tools. An unanchored allow glob such as `"*"`, `"B*"`, or `"mcp__*"` is skipped and doesn't auto-approve anything.

A deny or ask rule whose tool name matches no known tool produces a [startup warning](https://code.claude.com/docs/en/errors.md#matches-no-tool) to catch typos. Tool names containing `_` or `*` are exempt from the check, and so are the names of tools Claude Code has removed, such as `TaskOutput`.

## Tool-specific permission rules

### Bash

Bash rules match the whole command text, with `*` standing in for any text. [Wildcard patterns](#wildcard-patterns) shows which commands each rule shape matches and where to put the `*`. The rest of this section covers how Claude Code matches compound commands and wrappers, which wrappers and `find` actions a prefix rule can't approve, what a rule doesn't match, read-only commands, and redirections.

#### Compound commands

> [!TIP]
>
> Claude Code is aware of shell operators, so a rule like `Bash(safe-cmd *)` won't give it permission to run the command `safe-cmd && other-cmd`. The recognized command separators are `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines. A rule must match each subcommand independently.

Deny and ask rules apply when any subcommand matches them, including a command nested inside a subshell, a command substitution, or a control-flow body such as a `for` loop. An ask rule like `Bash(git clean *)` still prompts you for `cd /tmp && git clean -f` or `echo "$(git clean -f)"`, even in [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode).

When `&&` or `||` has nothing after it, such as in `npm test &&`, Claude Code treats the command as unparseable and doesn't split it into subcommands for allow-rule matching, so a rule such as `Bash(npm *)` doesn't approve it.

When you approve a compound command with "Yes, and don't ask again", Claude Code saves a separate rule for each subcommand that requires approval, rather than a single rule for the full compound string. For example, approving `git status && npm test` saves a rule for `npm test`, so future `npm test` invocations are recognized regardless of what precedes the `&&`. Subcommands like `cd` into a directory outside your working directories generate their own Read rule for that path. Up to 5 rules may be saved for a single compound command.

#### Wrappers

Before matching Bash rules, Claude Code strips a fixed set of wrappers, so a rule like `Bash(npm test *)` also matches `timeout 30 npm test`. The stripped wrappers are `timeout`, `time`, `nice`, `nohup`, and `stdbuf`, plus the shell builtins `command` and `builtin`, and zsh's `noglob`. Each runs its argument as the actual command. Two related forms aren't stripped: the query form `command -v`, which looks up a command rather than running one, and zsh's `nocorrect`.

Claude Code also strips a leading assignment of certain known-safe environment variables, so `Bash(npm test *)` matches `NODE_ENV=test npm test`. An allow rule won't match past an assignment of any other variable. A deny or ask rule matches past any leading assignment, so `Bash(rm *)` in deny still matches `FOO=bar rm -rf tmp/`.

Bare `xargs` is also stripped, so `Bash(grep *)` matches `xargs grep pattern`. Stripping applies only when `xargs` has no flags: an invocation like `xargs -n1 grep pattern` is matched as an `xargs` command, so rules written for the inner command do not cover it.

This wrapper list is built in and is not configurable. Development environment runners such as `direnv exec`, `devbox run`, `mise exec`, `npx`, and `docker exec` are not in the list. Because these tools execute their arguments as a command, a rule like `Bash(devbox run *)` matches whatever comes after `run`, including `devbox run rm -rf .`. To approve work inside an environment runner, write a specific rule that includes both the runner and the inner command, such as `Bash(devbox run npm test)`. Add one rule per inner command you want to allow.

#### Exec wrappers and `find` actions

A prefix rule like `Bash(watch *)` or `Bash(find *)` can't auto-approve the following commands, so in Manual mode they prompt:

* **Exec wrappers**: such as `watch`, `setsid`, `ionice`, and `flock`
* **`find`**: with an action that runs commands, deletes files, or writes files, such as `-exec`, `-delete`, `-rm`, or `-fprint`, or with `-files0-from`, which takes the paths to search from a file

To approve a specific invocation that has no `*` in it, write an exact-match rule for the full command string, such as `Bash(find build -type f -delete)`.

When the command has a `*`, as in `find . -name '*.tmp' -delete`, Claude Code reads the rule as a [wildcard pattern](#wildcard-patterns), not an exact match, so the command still prompts. Approve it each time it prompts, or use a [PreToolUse hook](https://code.claude.com/docs/en/hooks.md#pretooluse-decision-control) that returns `"allow"` for it.

#### What a Bash rule doesn't match

A Bash rule matches the command text Claude writes, after Claude Code splits [compound commands](#compound-commands) and strips [wrappers](#process-wrappers). It doesn't match the same program invoked in a different form, so a deny or ask rule covers the invocation Claude usually produces and isn't a security boundary around the program. These rules in `deny` or `ask` stop the first form and not the others:

| Rule | Stops | Doesn't stop |
| :- | :- | :- |
| `Bash(curl *)` | `curl https://example.com` | `/usr/bin/curl https://example.com`, `sh -c 'curl https://example.com'` |
| `Bash(rm *)` | `rm -rf build/` | `/bin/rm -rf build/`, `bash -c 'rm -rf build/'` |
| `Bash(git push *)` | `git push origin main` | `git -C . push origin main`, `git -c push.default=current push origin main`, `git 'push' origin main` |

Your other rules and the permission mode decide the commands in the last column.

For filesystem and network enforcement that doesn't depend on the command text, use [sandboxing](https://code.claude.com/docs/en/sandboxing.md). To inspect the full command text with your own logic before it runs, use a [PreToolUse hook](#extend-permissions-with-hooks).

#### Read-only commands

Claude Code recognizes a built-in set of Bash commands as read-only and runs them without a permission prompt in every mode, except as [`permissions.blockReadsOutsideWorkingDirectories`](https://code.claude.com/docs/en/settings-reference#permissions-blockreadsoutsideworkingdirectories) changes for paths outside your working directories. The set includes `ls`, `cat`, `echo`, `pwd`, `head`, `tail`, `grep`, `find`, `wc`, `which`, `diff`, `stat`, `du`, `cd`, and read-only forms of `git`. The set is not configurable; to require a prompt for one of these commands, add an `ask` or `deny` rule for it. In auto mode, these commands can also wait for the classifier's review; see [how the classifier evaluates actions](https://code.claude.com/docs/en/permission-modes.md#how-the-classifier-evaluates-actions).

A redirect such as `ls > out.txt` adds a check on the target. See [Redirections](#redirections).

Unquoted glob patterns are permitted for commands whose every flag is read-only, so `ls *.ts` and `wc -l src/*.py` run without a prompt.

In Manual mode, commands from this set still prompt in these cases:

* **Unquoted globs for commands with write-capable flags**: commands with write-capable or exec-capable flags, such as `find`, `sort`, `sed`, and `git`, prompt when an unquoted glob is present, because the glob could expand to a flag like `-delete`.
* **`docker` pointed at another daemon**: read-only forms of `docker` prompt when the command carries a flag that selects a different daemon, such as `-H`, `--context`, or Podman's `--url` and `--connection`.
* **`file` with path-opening flags**: `file` prompts when it passes `-m`/`--magic-file` or `-f`/`--files-from`, because those flags make `file` open the paths named in the flag's value.
* **`ps` that could print environment variables**: `ps` prompts when one of its arguments could act as the `e` option, such as in `ps auxe` or `ps aux -e`, because that option prints process environment variables. `ps aux` and `ps -ef` run without a prompt. The check on dashed forms such as `ps aux -e` requires Claude Code v2.1.290 or later.
* **Network paths on Windows**: a command whose arguments include a network (UNC) path, such as `\\server\share\file`, prompts because accessing a network path can send your Windows credentials to the host it names. The same check applies to [PowerShell tool](https://code.claude.com/docs/en/tools-reference.md#powershell-tool) commands.
* **Writes to special shell variables**: a command that sets, unsets, or loops over certain special shell variables, such as `PATH` or `IFS`, prompts even when the rest of the command is read-only.
* **Commands the analysis can't parse**: when Claude Code can't fully parse a command, it asks for approval instead of treating the command as read-only. Commands longer than 10,000 characters always prompt because they exceed what the analysis parses.

A `cd` into a path inside your working directory or an [additional directory](#working-directories) is also read-only, and a compound command like `cd packages/api && ls` runs without a prompt when each part qualifies on its own. These combinations prompt even when each part is read-only:

* **`cd` with `git`**: prompts when the `cd` changes into a different directory, since running `git` in a new directory can execute that directory's hooks. A `cd` whose target resolves to the current working directory is a no-op and doesn't trigger the prompt.
* **`cd` with a redirect**: prompts when Claude Code can't determine which directory the redirect target resolves against after the `cd` runs. A command whose only redirect target is `/dev/null`, such as `cd app; grep -r pattern . 2>/dev/null`, doesn't prompt, because `/dev/null` doesn't depend on the working directory.

> [!WARNING]
>
> Bash permission patterns that try to constrain command arguments are fragile. For example, `Bash(curl http://github.com/ *)` intends to restrict curl to GitHub URLs, but won't match variations like:
>
> * Options before URL: `curl -X GET http://github.com/...`
> * Different protocol: `curl https://github.com/...`
> * Redirects: `curl -L http://short.example.com/xyz`, which redirects to GitHub
> * Variables: `URL=http://github.com && curl $URL`
>
> For more reliable URL filtering, consider:
>
> * **Restrict Bash network tools**: use deny rules to stop `curl`, `wget`, and similar commands, then use the WebFetch tool with `WebFetch(domain:github.com)` permission for allowed domains. A deny rule doesn't match the same program by path or inside `sh -c`, so pair it with the [sandbox network allowlist](https://code.claude.com/docs/en/sandboxing.md#network-isolation) when the restriction must hold; see [what a Bash rule doesn't match](#bash-rule-limits)
> * **Use PreToolUse hooks**: implement a hook that validates URLs in Bash commands and blocks disallowed domains
> * **Add CLAUDE.md guidance**: describe your allowed curl patterns in `CLAUDE.md`. This shapes what Claude tries but doesn't enforce a boundary, so pair it with one of the options above
>
> Note that using WebFetch alone doesn't prevent network access. If Bash is allowed, Claude can still use `curl`, `wget`, or other tools to reach any URL.

#### Redirections

When a command redirects output or input, Claude Code checks the redirect target against your file rules as if Claude wrote or read that file directly:

* **Output redirects**: for `> file`, `>> file`, or `2> file`, the check covers your `Edit` allow and deny rules, [protected paths](https://code.claude.com/docs/en/permission-modes.md#protected-paths), and the [working directories](#working-directories). A rule such as `Bash(git commit *)` allows the command, not the target. A target that starts with `~` or contains a glob character needs your approval.
* **Input redirects**: for `< file`, the check covers your `Read` allow and deny rules and the working directories. A target outside the working directories needs your approval unless an allow rule covers it. A target that contains a glob pattern, or a relative path that follows a `cd` in the same command, needs your approval even when an allow rule covers it. Claude Code checks input targets in v2.1.257 and later.

Targets with no file behind them aren't checked: `/dev/null`, file-descriptor forms such as `2>&1` and `<&3`, and here-docs and here-strings.

Claude Code also checks the files a `tee` command writes, including in a pipeline such as `make | tee build.log`. The check covers your `Edit` allow and deny rules, [protected paths](https://code.claude.com/docs/en/permission-modes.md#protected-paths), and the [working directories](#working-directories). An allow rule such as `Bash(tee *)` doesn't cover a destination outside the working directories. Claude Code checks `tee` targets in v2.1.269 and later.

### PowerShell

PowerShell permission rules use the same shape as [Bash rules](#wildcard-patterns), and a bare `PowerShell` or `PowerShell(*)` matches every command. This configuration allows `Get-ChildItem` and `git commit` commands while blocking `Remove-Item`:

```json theme={null}
{
  "permissions": {
    "allow": [
      "PowerShell(Get-ChildItem *)",
      "PowerShell(git commit *)"
    ],
    "deny": [
      "PowerShell(Remove-Item *)"
    ]
  }
}
```

Common aliases are canonicalized before matching. A rule written for the cmdlet name also matches its aliases, so `PowerShell(Get-ChildItem *)` matches `gci`, `ls`, and `dir` as well. Matching is case-insensitive.

Claude Code parses the PowerShell AST and checks each command in a compound command independently. Pipeline operators `|`, statement separators `;`, and on PowerShell 7+ the chain operators `&&` and `||` split a compound command into subcommands. A rule must match every subcommand for the compound command to be allowed.

### Read and Edit

To block Claude's file tools from reading a file or directory, add a `Read` deny rule for its path, such as `Read(./.env)` or `Read(./secrets/**)`; [Exclude sensitive files](https://code.claude.com/docs/en/settings-reference.md#exclude-sensitive-files) has a paste-ready example. If your project has a `.claudeignore` file, it has no effect, so move its entries into `Read` deny rules.

#### What `Read` and `Edit` rules cover

`Edit` rules apply to all built-in tools that edit files. Claude makes a best-effort attempt to apply `Read` rules to all built-in tools that read files like Grep and Glob, to `@file` mentions in your prompts, and to the selection and open-file context that a connected [IDE](https://code.claude.com/docs/en/vs-code.md#the-built-in-ide-mcp-server) shares with Claude.

A `Read(path)` deny rule also applies to image paths you paste into a prompt and directories you @-mention:

* **Image path**: when you paste an image's path or drag an image file into your prompt in the terminal and the rule matches that path, Claude Code doesn't attach the image. If the paste holds no other image, the path stays in your prompt as text.
* **Directory**: the [listing Claude receives](https://code.claude.com/docs/en/common-workflows.md#reference-files-and-directories) leaves out the file and directory names the rule matches.

Claude Code checks pasted image paths and directory listings in v2.1.290 and later.

A `Read` deny rule also blocks the [Edit and Write tools](https://code.claude.com/docs/en/errors.md#file-is-covered-by-a-read-deny-rule) on the same path, including creating a new file there. NotebookEdit isn't covered, so add an `Edit` deny rule for paths no tool may change. For the Write tool, the check requires Claude Code v2.1.228 or later.

> [!WARNING]
>
> Read and Edit deny rules apply to Claude's built-in file tools, to file commands Claude Code recognizes in Bash, such as `cat`, `head`, `tail`, `sed`, and `tee`, and to the targets of Bash [redirections](#redirections) such as `> file` and `< file`. They don't apply to a command that reads files without naming them, such as `grep -r pattern .` run from the directory that holds the file, or to arbitrary subprocesses that read or write files indirectly, like a Python or Node script that opens files itself. For OS-level enforcement that blocks all processes from accessing a path, [enable the sandbox](https://code.claude.com/docs/en/sandboxing.md).

#### `Write(path)`, `NotebookEdit(path)`, and `Glob(path)` rules never match

Claude Code checks file permissions against `Edit(path)` and `Read(path)` rules only. If you write a path rule for `Write`, `NotebookEdit`, `Glob`, or legacy `MultiEdit`, Claude Code accepts the rule but never matches a read or edit against it.

Use `Edit(docs/**)` in place of `Write(docs/**)`, `NotebookEdit(docs/**)`, or `MultiEdit(docs/**)`, and `Read(docs/**)` in place of `Glob(docs/**)`. To match every use of the Write, NotebookEdit, or Glob tool regardless of path, write only the tool name.

#### How path patterns match

Read and Edit rules both use [gitignore](https://git-scm.com/docs/gitignore) pattern syntax with four distinct pattern types:

| Pattern | Meaning | Example | Matches |
| - | - | - | - |
| `//path` | Absolute path from filesystem root | `Read(//Users/alice/secrets/**)` | `/Users/alice/secrets/**` |
| `~/path` | Path from home directory | `Read(~/Documents/*.pdf)` | `/Users/alice/Documents/*.pdf` |
| `/path` | Path relative to the settings source | `Edit(/src/**/*.ts)` | `<primary working directory>/src/**/*.ts` in project settings |
| `path` or `./path` | Path relative to current directory | `Read(*.env)` | `<cwd>/*.env` |

> [!WARNING]
>
> A pattern like `/Users/alice/file` isn't an absolute path. The single leading slash anchors at the settings source, not the filesystem root. Use `//Users/alice/file` for absolute paths.

##### Where a pattern anchors

A `/path` pattern anchors at a directory associated with the settings source that defines it, so the same rule matches different locations depending on where you put it:

| Rule defined in | `/path` resolves to |
| :- | :- |
| Project settings at `.claude/settings.json` | `<primary working directory>/path` |
| Local settings at `.claude/settings.local.json` | `<primary working directory>/path` |
| User settings at `~/.claude/settings.json` | `~/.claude/path` |
| A file passed with `--settings <file>` | `<directory of file>/path` |
| CLI flags or session rules | `<primary working directory>/path` |

A rule you add through `/permissions` follows the row for the settings file you save it to.

Local settings rules anchor at the session's [primary working directory](#working-directories), not at the repository root where Claude Code [stores the file](#permission-system) in v2.1.211 and later. In a session started at the repository root, the two directories are the same; in a [worktree](https://code.claude.com/docs/en/worktrees.md) session, a shared rule such as `Edit(/src/**)` matches that worktree's own `src/` directory.

A deny rule such as `Read(/secrets/**)` in user settings blocks `~/.claude/secrets/**`, not a `secrets` directory in your project. To write a rule in user settings that applies inside every project, use a `//` absolute path or a `~/` home-relative path instead.

On Windows, paths are normalized to POSIX form before matching. `C:\Users\alice` becomes `/c/Users/alice`, so use `//c/**/.env` to match `.env` files anywhere on that drive. To match across all drives, use `//**/.env`.

Examples:

* `Edit(/docs/**)`: edits in `<primary working directory>/docs/`, not `/docs/` or `<primary working directory>/.claude/docs/`
* `Read(~/.zshrc)`: reads your home directory's `.zshrc`
* `Edit(//tmp/scratch.txt)`: edits the absolute path `/tmp/scratch.txt`
* `Read(src/**)`: as an allow rule, reads from `<current-directory>/src/` only; as a deny or ask rule, matches a `src` directory at any depth under the current directory

##### How deep a pattern matches

A rule only matches files under its anchor; within that bound, matching depth depends on the pattern shape and, for single-segment directory patterns, the rule type, described below. Bare filenames follow gitignore semantics and match at any depth, so `Read(.env)` and `Read(**/.env)` are equivalent:

| Deny rule | Blocks | Does not block |
| - | - | - |
| `Read(.env)` or `Read(**/.env)` | any `.env` at or under the current directory | `.env` in a parent directory or another project |
| `Read(//**/.env)` | any `.env` anywhere on the filesystem | nothing; the rule is anchored at the filesystem root |

A relative pattern with a single directory segment, such as `src/**`, matches at different depths depending on the rule type:

* **Allow rules**: `Edit(src/**)` matches only `<cwd>/src` and the files under it. To allow a directory name at any depth, write `Edit(**/src/**)`.
* **Deny and ask rules**: `Read(secrets/**)` matches a directory named `secrets` at any depth under the current directory, so the rule also applies to nested copies.

Every other pattern shape matches at the same depth in every rule type: `Edit(/src/**)` and `Edit(src/components/**)` match only at their anchored location, while `Edit(**/src/**)` matches at any depth.

The following example shows each pattern shape against a project with a top-level `src/` directory and a nested copy under `vendor/`:

```text theme={null}
<current-directory>/
├── src/
│   └── app.ts
└── vendor/
    └── pkg/
        └── src/
            └── lib.js
```

| Rule | Matches `src/app.ts` | Matches `vendor/pkg/src/lib.js` |
| :- | :- | :- |
| `Edit(src/**)` as an allow rule | Yes | No |
| `Edit(src/**)` as a deny or ask rule | Yes | Yes |
| `Edit(/src/**)` in any rule type | Yes | No |
| `Edit(**/src/**)` in any rule type | Yes | Yes |

> [!NOTE]
>
> In gitignore patterns, `*` matches within a single path segment and can appear at any position in the pattern, while `**` matches across directories.

#### Special characters and `!` negation

When you approve a file path with "Yes, and don't ask again", Claude Code escapes gitignore pattern characters in that path, such as `[`, `]`, and `*`, so the generated rule matches only the literal path you approved. Rules you write yourself aren't escaped.

You don't need to escape parentheses in a path, so `Edit(./Finance (2024)/**)` matches the `Finance (2024)` folder as spelled.

A deny or ask rule whose path isn't usable as a gitignore pattern still guards that exact path. An allow rule with an unusable pattern doesn't approve anything.

A deny or ask pattern that starts with `!` is a gitignore negation. It carves the paths it matches out of the `path` or `./path` rules listed before it. In one settings file's `deny` list, `Read(*.env)` followed by `Read(!sample.env)` blocks every file whose name ends in `.env` at any depth, except files named `sample.env`. A `!` rule listed first carves nothing out.

The carve-out reaches only rules from the same source. A `Read(!.env)` in project settings or in `--disallowedTools` doesn't cancel a `Read(./.env)` deny from managed settings or any other settings file.

Two limits narrow what a `!` pattern can carve out:

* Claude Code reads a `!` pattern relative to the current directory even when `/`, `~/`, or `//` follows the `!`, so the pattern can't reach a rule anchored with one of those prefixes. `Read(!~/notes/public/**)` carves nothing out of `Read(~/notes/**)`.
* A carve-out can't reopen a file inside a directory that a rule blocks as a whole. With `Read(secrets/**)` and `Read(!secrets/public/**)`, Claude Code still blocks `secrets/public` along with the rest of `secrets`.

#### Symlinks

When a file path Claude requests goes through a symlink, the permission check covers two paths: the one Claude requested and the file it resolves to. This applies to symbolic links on macOS, Linux, and Windows, and to directory junctions on Windows.

##### How rules match a symlinked path

Allow and deny rules treat the requested path and the file it resolves to differently:

* **Allow rules**: apply only when both the requested path and the file it resolves to match. A read through a symlink inside an allowed directory that points outside it doesn't match the rule.
* **Deny rules**: apply when either the requested path or the file it resolves to matches. A symlink that points to a denied file is itself denied. For example, with `Read(./project/**)` allowed and `Read(~/.ssh/**)` denied, a symlink at `./project/key` pointing to `~/.ssh/id_rsa` is blocked: the target fails the allow rule and matches the deny rule.

On macOS and Linux, a deny or ask rule written through a symlinked directory with a `//`, `~/`, or `/` pattern also applies at the directory's real location. For example, on macOS, where `/etc` resolves to `/private/etc`, `Read(//etc/**)` blocks `/private/etc/hosts` too. Before v2.1.268, a deny or ask rule written through a symlinked directory didn't apply to a path given by its real location.

Grep and Glob search the directory the `path` argument resolves to. Claude Code applies `Read` deny rules to that directory.

##### Attachments through a symlink

A `Read` deny rule also covers these attachments, matching each one on either the named path or the file it resolves to. Claude Code leaves an attachment out of the conversation when a rule matches it:

* **`@`-mentions**: a file or directory you mention in your prompt. A refused file leaves nothing in the conversation, and a [directory's listing](#read-and-edit) leaves out the names a rule covers.
* **Pasted images**: an image whose path you paste or drag into the prompt in the terminal
* **Changed files**: a file Claude Code re-reads after it changes on disk
* **IDE context**: the selection and open-file context a connected IDE shares

With [`permissions.blockReadsOutsideWorkingDirectories`](https://code.claude.com/docs/en/settings-reference#permissions-blockreadsoutsideworkingdirectories) on, or in a [`--restricted`](https://code.claude.com/docs/en/cli-reference#cli-flags) session, these attachments are also left out when they come from a path where that setting or flag refuses Claude's file reads.

This line in place of a file you `@`-mentioned means Claude Code couldn't work out where the path leads, for example because its symlinks form a loop:

```text theme={null}
Referenced <path> (not read: could not be examined)
```

Claude is told to read the path with its file tools instead, which can succeed when Claude Code only ran out of time to examine the path.

When the path's symlinks don't resolve, that read is [refused](https://code.claude.com/docs/en/errors.md#refusing-after-a-symlink-changed) too, so fix the link on disk or `@`-mention the file by a path that resolves.

##### Writes through a symlink

If the path Claude asks to edit or write is itself a symlink, the Edit and Write tools [refuse the write and direct Claude to the link's target](https://code.claude.com/docs/en/errors.md#refusing-after-a-symlink-changed).

A write can still pass through a symlink when a directory on the way to the file is a symlink, or when a Bash or PowerShell command does the writing. For those writes, what happens depends on where the file the write resolves to sits relative to your [working directories](#working-directories) and the [protected paths](https://code.claude.com/docs/en/permission-modes.md#protected-paths):

* **Resolves outside the working directories**: when the requested path is inside your working directories and the file it resolves to isn't, the write isn't auto-approved in [`acceptEdits` mode](https://code.claude.com/docs/en/permission-modes#auto-approve-file-edits-with-acceptedits-mode). In [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode), unless an allow rule approves the write, you're prompted for it instead of the classifier deciding. The prompt names the path the write resolves to.
* **Resolves to a protected path that the requested path doesn't name**: the [protected paths table](https://code.claude.com/docs/en/permission-modes.md#protected-paths) gives the outcome for each permission mode, except that where the table routes the write to the classifier, this write prompts you instead.

##### Paths that can't be resolved or that change

When Claude Code can't determine where a path leads on disk, for example because symlinks on it form a loop, the Read, Edit, and Write tools [refuse the operation](https://code.claude.com/docs/en/errors.md#refusing-after-a-symlink-changed).

When a tool then opens the approved file, it [confirms that the path still resolves to the location the permission check approved](https://code.claude.com/docs/en/errors.md#refusing-after-a-symlink-changed).

#### Network paths

When Claude's file-reading tools, such as Read, Grep, and Glob, read from a network path, the read gets its own permission check. A network path is one that can reach another computer: on Windows, a UNC path such as `\\server\share\file`, and on macOS and Linux, a `/net` automount path such as `/net/fileserver/notes.txt`. Looking up such a path can contact the host it names, and on Windows that contact can send the host your credentials. Shell commands have their own check: in Manual mode, a read-only Bash or PowerShell command whose arguments include a UNC path [still prompts on Windows](#read-only-commands).

In Claude Code v2.1.292 and later, each of these leaves the prompt in place:

* **Allow rules**: a rule doesn't pre-approve the read, including a rule for the whole tool, such as `Read`
* **PreToolUse hooks**: a [hook](#extend-permissions-with-hooks) that returns `"allow"` doesn't skip the prompt
* **Auto mode**: the prompt comes to you, and the [classifier](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode) doesn't decide the read

In `dontAsk` mode, Claude Code denies the read instead of prompting. In `bypassPermissions` mode, and in interactive terminal sessions in plan mode with [bypass permissions](https://code.claude.com/docs/en/permission-modes.md#skip-all-checks-with-bypasspermissions-mode) available, the read runs without this prompt.

To read files on a network share without this prompt, give the share a local path first:

* **Windows**: map the share to a drive letter and pass the drive with `--add-dir` when you launch Claude Code, as [Working directories](#working-directories) describes. Reads under a drive you add later with `/add-dir`, or list in `additionalDirectories` in a settings file, still prompt. To stop those prompts for a share mapped to `Z:`, start a new session in PowerShell with `claude --add-dir Z:\`.
* **macOS and Linux**: mount the share at a local path, such as a directory under `/mnt` or `/Volumes`, and read the files from there, as [Working directory is a network path](https://code.claude.com/docs/en/errors.md#working-directory-is-a-network-path) describes

### WebFetch

WebFetch rules use a `domain:` prefix and match against the hostname of the requested URL. Matching is case-insensitive, supports `*` wildcards, and strips a trailing `.` from both the rule and the hostname so `example.com.` and `example.com` are treated the same.

* `WebFetch(domain:example.com)` matches requests to `example.com` only. To also cover subdomains such as `api.example.com`, add a `WebFetch(domain:*.example.com)` rule
* `WebFetch(domain:*.example.com)` matches any subdomain at any depth, such as `api.example.com` or `a.b.example.com`, but not `example.com` itself
* `WebFetch(domain:*)` matches every domain. It isn't the same as a bare `WebFetch` rule; see [Allow or deny every fetch](#allow-or-deny-every-fetch)

In any position other than a leading `*.` or a bare `*`, the wildcard matches only the text between two dots. `WebFetch(domain:example.*)` matches `example.org`, where `*` becomes `org`, but not `example.evil.com`, where `*` would have to become `evil.com` and cross a dot. This keeps a trailing wildcard from matching domains an attacker could register.

Wildcards in `WebFetch` rules require Claude Code v2.1.172 or later to match fetches.

#### Allow or deny every fetch

A bare `WebFetch` rule is the tool name with no `domain:` part, such as `"deny": ["WebFetch"]`. Both it and `WebFetch(domain:*)` cover every URL, but Claude Code applies them differently, and only the `domain:` form also adds its domain to the sandbox's [allowed or denied domain list](https://code.claude.com/docs/en/sandboxing.md#network-isolation). That section lists the wildcard forms the sandbox honors and the version that added bare `*`.

Each row shows what a rule does in the `allow` list and in the `deny` list:

| Rule | In `allow` | In `deny` |
| :- | :- | :- |
| `WebFetch` | Claude fetches without prompting you. Doesn't change which hosts sandboxed commands can reach. | Claude Code removes the `WebFetch` tool, so Claude can't fetch at all. Doesn't change which hosts sandboxed commands can reach. |
| `WebFetch(domain:*)` | Claude fetches without prompting you, and sandboxed commands can reach any host. | Claude Code keeps the tool and refuses each fetch, and sandboxed commands can't reach any host. |

The two forms also differ on reads of [artifacts](https://code.claude.com/docs/en/artifacts.md), the pages the Artifact tool publishes on claude.ai. A bare `WebFetch` deny or ask rule doesn't apply to those reads. A `domain:` rule covering `claude.ai` or the `*.claudeusercontent.com` content host, such as `WebFetch(domain:claude.ai)` or `WebFetch(domain:*)`, denies each read or prompts before it. An [`Artifact` rule](https://code.claude.com/docs/en/artifacts#disable-artifacts) does the same.

When a rule blocks a read, the denial names the rule. Before v2.1.268, a bare `WebFetch` deny rule blocked every artifact read, and a bare ask rule prompted before each one.

To let Claude fetch freely while keeping the sandbox allowlist as it is, use the bare form. This `settings.json` does that:

```json theme={null}
{
  "permissions": {
    "allow": ["WebFetch"]
  }
}
```

When you ask Claude to fetch a page, it fetches without a prompt. When you ask it to run a [sandboxed](https://code.claude.com/docs/en/sandboxing.md) `curl` against a host outside the sandbox allowlist, Claude Code still prompts you for that host, because the bare rule didn't add the host to the allowlist.

In [auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode), Claude instead names the host in the command's [per-command allowed domains](https://code.claude.com/docs/en/sandboxing.md#per-command-allowed-domains-in-auto-mode) for the classifier to review.

### MCP

To match every tool from an MCP server, write `mcp__<server>__*`. To match one tool, write its full name, `mcp__<server>__<tool>`.

* `mcp__puppeteer` matches any tool provided by the `puppeteer` server
* `mcp__puppeteer__*` uses wildcard syntax and also matches all tools from the `puppeteer` server
* `mcp__puppeteer__puppeteer_navigate` matches the `puppeteer_navigate` tool provided by the `puppeteer` server

For `<server>`, write the server's name the way it appears in that server's tool names. These examples show the rule to write for a name with special characters, a server from a plugin, and a name that contains `__` or ends in `_`:

* **Names with characters such as `.` or spaces**: those characters become `_`, so for a server you configured as `my.server`, write `mcp__my_server__*`
* **Servers that a plugin provides**: `<server>` takes the [plugin-scoped form](https://code.claude.com/docs/en/mcp.md#plugin-provided-mcp-servers), so for the `database-tools` server in a plugin named `my-plugin`, write `mcp__plugin_my-plugin_database-tools__*`
* **A `<server>` that contains `__` or ends in `_`**: write the wildcard form, `mcp__<server>__*`, with the whole name. For a server named `reports__v2`, write `mcp__reports__v2__*`. The bare `mcp__reports__v2` and the shorter `mcp__reports` don't match its tools as allow rules, because Claude Code reads both as rules for a server named `reports`.

  As a deny or ask rule, though, each of those two names also covers every tool of the `reports__v2` server. To cover a server named `reports` alone, write one rule per tool in the `mcp__reports__<tool>` form, or rename one of the servers.

If your organization has set a [claude.ai connector](https://code.claude.com/docs/en/mcp.md#organization-controls-on-connector-tools) tool to `ask` and that setting reaches Claude Code in your session, allow rules for that tool don't take effect: Claude Code prompts on every call, even in `auto` and `bypassPermissions` modes. In `dontAsk` mode, which never prompts, Claude Code denies the call instead. Tools from connectors Claude Code fetches itself appear as `mcp__claude_ai_<server>__<tool>`.

In a [Cowork](https://claude.com/docs/cowork/overview) session in the Claude Desktop app, Claude runs shell commands through Cowork's `mcp__workspace__bash` tool rather than the built-in `Bash` tool, and Cowork likewise provides `mcp__workspace__web_fetch` for web fetches. Claude Code also applies deny rules that name the whole `Bash` or `WebFetch` tool to these Cowork tools, so a managed `Bash` deny rule stops Claude from running shell commands in Cowork. When Claude Code blocks such a call, the message names the Cowork tool: `Permission to use mcp__workspace__bash has been denied.` Allow rules don't carry over: Claude Code never applies a `Bash` allow rule to `mcp__workspace__bash`.

### Agent (subagents)

Use `Agent(AgentName)` rules to control which [subagents](https://code.claude.com/docs/en/sub-agents.md) Claude can use:

* `Agent(Explore)` matches the Explore subagent
* `Agent(Plan)` matches the Plan subagent
* `Agent(my-custom-agent)` matches a custom subagent named `my-custom-agent`

Add these rules to the `deny` array in your settings or use the `--disallowedTools` CLI flag to disable specific agents. To disable the Explore agent:

```json theme={null}
{
  "permissions": {
    "deny": ["Agent(Explore)"]
  }
}
```

### Cd

`Cd` rules control which directories the [`/cd` command](https://code.claude.com/docs/en/commands) can move the session to. `Cd` is not a model-invocable tool: Claude can't call it, and the rules apply only when you run `/cd` yourself.

A bare `Cd` deny rule disables `/cd` entirely. A `Cd(<path-pattern>)` deny rule blocks matching targets. Deny rules check every spelling of the target, including each symlink hop it resolves through, so a rule written for one path also blocks targets that resolve to it.

Adding any `Cd` allow rule switches `/cd` to allowlist mode: the resolved target directory must match one of your allow rules, or `/cd` refuses. With no `Cd` rules configured, `/cd` keeps its default behavior and prompts you to trust an unfamiliar directory.

Path patterns share the `//`, `~/`, and `/` anchors from [Read and Edit rules](#read-and-edit), but matching is anchored to the whole directory path rather than gitignore-style. `*` matches exactly one path segment and `**` matches across segments. A trailing `/**` also matches its named root.

| Rule | Matches | Does not match |
| - | - | - |
| `Cd(~/code/*)` | `~/code/app` | `~/code/app/src`, `~/code` |
| `Cd(~/code/**)` | `~/code` and any directory under it | directories outside `~/code` |
| `Cd(**/node_modules)` | any `node_modules` directory at any depth under the current directory | `node_modules/pkg` |

## Extend permissions with hooks

[Claude Code hooks](https://code.claude.com/docs/en/hooks-guide.md) let you register custom shell commands that evaluate permissions at runtime. When Claude Code makes a tool call, PreToolUse hooks run before the permission prompt, for every tool except [`EndConversation`](https://code.claude.com/docs/en/tools-reference#endconversation-tool-behavior). The hook output can deny the tool call, force a prompt, or skip the prompt to let the call proceed.

### Precedence among rules, hooks, and mods

PreToolUse hook decisions don't bypass permission rules. Claude Code evaluates deny and ask rules regardless of what a PreToolUse hook returns: a matching deny rule blocks the call, and a matching ask rule still prompts even when the hook returned `"allow"` or `"ask"`. This preserves the deny-first precedence described in [Manage permissions](#manage-permissions), including deny rules set in managed settings.

That precedence covers hooks in settings files and in a plugin's `hooks/hooks.json`. A [mod](https://code.claude.com/docs/en/plugins/mods/overview.md) you install that handles the [`tool.check`](https://code.claude.com/docs/en/plugins/mods/events#approve-or-refuse-a-tool-call-before-the-user-is-asked) event gives its answer after the `PreToolUse` hooks have run. With [managed settings](https://code.claude.com/docs/en/settings.md#check-what-your-organization-enforces) on the machine, or a Team or Enterprise [`/login`](https://code.claude.com/docs/en/authentication#authentication-precedence) as the session's credential, these outcomes stay in place by default when the mod approves a call:

* A call that a deny rule refuses stays refused, and your organization can change that.
* A call that an ask rule would prompt for still prompts you.
* A call that a `PreToolUse` hook or [`permissions.blockReadsOutsideWorkingDirectories`](https://code.claude.com/docs/en/settings-reference#permissions-blockreadsoutsideworkingdirectories) would prompt for still prompts you.
* A call that a `PreToolUse` hook blocked stays blocked, whichever settings file the hook comes from.
* A call that your [`--permission-prompt-tool`](https://code.claude.com/docs/en/cli-reference#cli-flags) or Agent SDK [`canUseTool` callback](https://code.claude.com/docs/en/agent-sdk/user-input#handle-tool-approval-requests) would be asked about is still put to that tool or callback.

With neither managed settings nor a Team or Enterprise `/login` as the session's credential, the mod can approve a call that a deny rule refuses or a `PreToolUse` hook blocked. A session that runs on an API key or a long-lived [`CLAUDE_CODE_OAUTH_TOKEN`](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) instead isn't using that login, even when that login is stored.

In that setup you aren't prompted when the mod approves a call that an ask rule, a `PreToolUse` hook, or `permissions.blockReadsOutsideWorkingDirectories` would prompt for. Your `--permission-prompt-tool` or `canUseTool` callback isn't asked about a call the mod approves, either. Auto mode, plan mode, and `dontAsk` mode each add an outcome of their own in every setup:

* **[Auto mode](https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode)**: a call the mod approves runs without a classifier check, except where the mod can't bypass your permission prompt tool or Agent SDK permission callback. There the classifier checks the call first.
* **[Plan mode](#hook-approvals-in-plan-mode)**: the mod can't approve a call that isn't read-only, such as a file edit or a shell command that writes.
* **[`dontAsk` mode](https://code.claude.com/docs/en/permission-modes#allow-only-pre-approved-tools-with-dontask-mode)**: the mod can approve a call that nothing but the mode would deny.

See [Decide whether to trust a mod](https://code.claude.com/docs/en/plugins/mods/overview.md#decide-whether-to-trust-a-mod), or [Manage mods for your organization](https://code.claude.com/docs/en/plugins/mods/admin.md#know-what-happens-by-default) if you deploy managed settings.

For a [tool that requires user interaction](https://code.claude.com/docs/en/permission-modes.md#actions-no-mode-auto-approves), such as `AskUserQuestion` or an MCP tool marked `requiresUserInteraction`, a mod's `tool.check` approval doesn't skip the prompt. Requires Claude Code v2.1.292 or later. MCP tools marked [`requiresUserInteraction`](https://code.claude.com/docs/en/mcp#require-approval-for-a-specific-tool) also still prompt when a hook returns `"allow"`, as do reads from [network paths](#network-paths) and connector tools [your organization set to `ask`](https://code.claude.com/docs/en/mcp#organization-controls-on-connector-tools) in sessions where that setting reaches Claude Code.

A blocking hook also takes precedence over allow rules. A hook that exits with code 2 stops the tool call before permission rules are evaluated, so the block applies even when an allow rule would otherwise let the call proceed. To run all Bash commands without prompts except for a few you want blocked, add `"Bash"` to your allow list and register a PreToolUse hook that rejects those specific commands. See [Block edits to protected files](https://code.claude.com/docs/en/hooks-guide.md#block-edits-to-protected-files) for a hook script you can adapt.

### Hook approvals in plan mode

In [plan mode](https://code.claude.com/docs/en/permission-modes.md#analyze-before-you-edit-with-plan-mode), apart from `ExitPlanMode`, your `PreToolUse` hook's `"allow"` has no effect on a file edit or another call that isn't read-only. You get the same prompt, block, or approval the call would get with no hook, and Claude Code still applies any `updatedInput` the hook returns. If the hook answers [`ExitPlanMode`](https://code.claude.com/docs/en/hooks#allow-with-updatedinput) with `"allow"` and `updatedInput`, that tool still runs without a prompt.

In plan mode, a mod that handles `tool.check` also can't approve a file edit or another call that isn't read-only, though it can still block such a call. To lift this limit on hook and mod approvals, [approve the plan](https://code.claude.com/docs/en/permission-modes.md#review-and-approve-a-plan) or switch to another permission mode.

## Working directories

By default, Claude has access to files in the directory where you launched it. That directory is the session's primary working directory until you [move the session with `/cd`](#move-the-session-to-another-directory). You can extend this access:

* **During startup**: use `--add-dir <path>` CLI argument
* **During session**: use `/add-dir` command
* **Persistent configuration**: add to `additionalDirectories` in [settings files](https://code.claude.com/docs/en/settings.md#where-settings-live)

Files in additional directories follow the same permission rules as the original working directory: they become readable without prompts apart from the [network path](#network-paths) check, and file editing permissions follow the current permission mode.

You can't add most [network paths](https://code.claude.com/docs/en/errors.md#working-directory-is-a-network-path), such as the UNC share `\\server\share`, as working directories, because looking one up can contact the host it names. On Windows, map the share to a drive letter instead and pass the drive with `--add-dir` at launch.

Set [`permissions.blockReadsOutsideWorkingDirectories`](https://code.claude.com/docs/en/settings-reference#permissions-blockreadsoutsideworkingdirectories) to make the file tools refuse the paths it fences in every permission mode. In auto mode, Claude Code offers to turn it on the first time Claude [reads outside the working directories](https://code.claude.com/docs/en/permission-modes.md#first-read-outside-the-working-directories).

In background sessions on macOS, the session host requests access to protected folders such as `~/Desktop`, `~/Documents`, and `~/Downloads` separately from your terminal when Claude needs to read or write files there; if reads there fail with `Operation not permitted`, see [how to grant folder access to background sessions](https://code.claude.com/docs/en/agent-view.md#background-sessions-can’t-read-desktop-documents-or-downloads-on-macos).

### Move the session to another directory

To move the session to a different primary working directory, rather than [adding a directory](#working-directories) alongside the current one, run `/cd <path>`. Claude Code keeps the conversation, loads the new directory's `CLAUDE.md`, and prompts you to [trust the workspace](#project-allow-rules-and-workspace-trust) if you haven't worked in it before. Afterward, Claude Code [finds the moved session](https://code.claude.com/docs/en/sessions.md#where-the-session-picker-looks) when you run `--resume` from the new directory.

As soon as you move, Claude Code applies the new directory's project configuration:

* Its project settings, including their permission rules and [hooks](https://code.claude.com/docs/en/hooks.md)
* Its [`.mcp.json` servers](https://code.claude.com/docs/en/mcp#project-scope), subject to the same [server approval](https://code.claude.com/docs/en/mcp.md#project-server-approvals-and-workspace-trust) as at startup, and the [local-scope](https://code.claude.com/docs/en/mcp.md#local-scope) MCP servers you registered in it
* The [plugins](https://code.claude.com/docs/en/plugins/overview.md) its settings enable, its [skills](https://code.claude.com/docs/en/skills.md#discovery-from-parent-and-nested-directories), and its [subagents](https://code.claude.com/docs/en/sub-agents.md)
* Its [`env`](https://code.claude.com/docs/en/settings-reference#env) values, applied on top of the environment variables from the previous directory's settings, which stay in effect

Claude Code also disconnects the previous directory's project and [local-scope](https://code.claude.com/docs/en/mcp.md#local-scope) MCP servers, and the servers of [plugins](https://code.claude.com/docs/en/mcp.md#plugin-provided-mcp-servers) that are no longer enabled after the move. It takes [additional directories](#working-directories) from the new directory's settings instead of the previous one's, and keeps the directories you added with `--add-dir` or `/add-dir`. Hooks the move activates still receive [`${CLAUDE_PROJECT_DIR}`](https://code.claude.com/docs/en/hooks#reference-scripts-by-path) set to the project root where the session started.

When the new directory isn't trusted yet, Claude Code lists in the trust prompt the allow rules, additional directories, hooks, and helper commands the directory's settings would activate, so you can review them before you accept. If you decline, the session stays where it is. Before v2.1.246, `/cd` didn't apply the new directory's settings, hooks, MCP servers, or skills until you resumed the session, and its trust prompt didn't list what the directory's settings would activate.

Restrict or disable `/cd` targets with [`Cd` permission rules](#cd).

### Additional directories grant file access, not configuration

Adding a directory extends where Claude can read and edit files. It doesn't make that directory a full configuration root: most `.claude/` configuration is not discovered from additional directories, though a few types are loaded as exceptions.

These exceptions apply only to directories added with the `--add-dir` flag or the `/add-dir` command, including directories the Agent SDK adds through the flag. Directories listed in `permissions.additionalDirectories` in a settings file grant file access only and don't load any of the configuration below.

The Agent SDK's [`additionalDirectories`](https://code.claude.com/docs/en/agent-sdk/typescript#options) option in TypeScript and [`add_dirs`](https://code.claude.com/docs/en/agent-sdk/python#claudeagentoptions) option in Python receive the exceptions too, even though the TypeScript option shares its name with the settings key. The SDK passes each entry to Claude Code as `--add-dir`, so those directories behave like flag-added directories. Skills, commands, and subagents from any flag-added directory load through the `project` [setting source](https://code.claude.com/docs/en/agent-sdk/claude-code-features.md#control-filesystem-settings-with-settingsources), so they don't load when you exclude that source with [`--setting-sources`](https://code.claude.com/docs/en/cli-reference) on the CLI or `settingSources` in the SDK, and [bare mode](https://code.claude.com/docs/en/headless.md#start-faster-with-bare-mode) skips the commands and subagents among them.

The following configuration types are loaded from `--add-dir` directories:

| Configuration | Loaded from `--add-dir` |
| :- | :- |
| [Skills](https://code.claude.com/docs/en/skills.md) in `.claude/skills/` | Yes, with live reload |
| [Command files](https://code.claude.com/docs/en/skills.md#where-skills-live) in `.claude/commands/` | Yes, without live reload. When the added directory and your project both define a command with the same name, Claude Code runs your project's command |
| [Subagents](https://code.claude.com/docs/en/sub-agents.md) in `.claude/agents/` | Yes, without live reload |
| [Settings](https://code.claude.com/docs/en/settings.md) in `.claude/settings.json` and `.claude/settings.local.json` | `enabledPlugins` and [`extraKnownMarketplaces`](https://code.claude.com/docs/en/settings-reference#extraknownmarketplaces) keys only |
| [CLAUDE.md](https://code.claude.com/docs/en/memory.md) files, `.claude/rules/`, and `CLAUDE.local.md` | Only when `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` is set. `CLAUDE.local.md` additionally requires the `local` setting source, which is enabled by default |

To load the skills, commands, and subagents from a subdirectory of your [primary working directory](#working-directories) mid-session, run `/add-dir` with that subdirectory's path. Claude Code loads them for the rest of the session without prompting you or adding a working directory, because the subdirectory is already readable. This requires Claude Code v2.1.257 or later.

Claude Code discovers output styles from the current working directory and its parents, your user directory at `~/.claude/`, and managed settings. Hooks and other `.claude/settings.json` keys load from the current working directory's `.claude/` folder with no parent-directory fallback, alongside your user `~/.claude/settings.json` and managed settings. `.claude/settings.local.json` loads from the git repository root instead, even when you start Claude Code in a subdirectory, except in the cases where Claude Code [doesn't use the repository root](https://code.claude.com/docs/en/settings.md#where-claude-code-looks-for-each-file), such as on Windows; before v2.1.211, it too loaded only from the current working directory. [Agent SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features.md#control-filesystem-settings-with-settingsources) sessions load it from the working directory in all versions.

To share that configuration across projects, use one of these approaches:

* **User-level configuration**: place files in `~/.claude/agents/`, `~/.claude/output-styles/`, or `~/.claude/settings.json` to make them available in every project
* **Plugins**: package and distribute configuration as a [plugin](https://code.claude.com/docs/en/plugins/overview.md) that teams can install
* **Launch from the config directory**: run Claude Code from the directory containing the `.claude/` configuration you want

## How permissions interact with sandboxing

Permissions and [sandboxing](https://code.claude.com/docs/en/sandboxing.md) are complementary security layers:

* **Permissions** control which tools Claude Code can use and which files or domains it can access. They apply to Bash, Read, Edit, WebFetch, MCP, and every other tool, except that a deny or ask rule can't block [`EndConversation`](https://code.claude.com/docs/en/tools-reference#endconversation-tool-behavior) while any other tool remains.
* **Sandboxing** provides OS-level enforcement that restricts shell commands' filesystem and network access. It applies to Bash, PowerShell, and [Monitor](https://code.claude.com/docs/en/tools-reference.md#monitor-tool) tool commands and their child processes.

Use both for defense-in-depth, since sandbox restrictions still apply even if a prompt injection bypasses Claude's decision-making. Paths and domains from both sandbox settings and permission rules are [merged into the final sandbox configuration](https://code.claude.com/docs/en/sandboxing.md#permission-rules).

When you enable sandboxing and leave `autoAllowBashIfSandboxed` at its default of `true`, sandboxed Bash commands run without prompting even if your permissions include a bare `Bash` ask rule, or the [equivalent `Bash(*)` form](#match-all-uses-of-a-tool): the sandbox boundary substitutes for that whole-tool prompt.

In [plan mode](https://code.claude.com/docs/en/permission-modes.md#analyze-before-you-edit-with-plan-mode), Claude Code skips this substitution. Without an ask rule, the [built-in read-only commands](#read-only-commands) still run without prompting, and any other shell command goes through the regular permission flow while you are still planning; see [plan mode](https://code.claude.com/docs/en/permission-modes.md#analyze-before-you-edit-with-plan-mode) for how Claude Code gates commands there. With a bare `Bash` ask rule, every Bash command prompts, including sandboxed read-only commands, the same as outside sandboxing.

These checks still apply:

* Content-scoped ask rules like `Bash(git push *)` still force a prompt
* Other sandboxed commands can go through the regular permission flow too, as [Auto-allow mode](https://code.claude.com/docs/en/sandboxing.md#auto-allow-mode) describes

Commands that won't run sandboxed, such as excluded commands, respect the bare `Bash` ask rule as usual. See [sandbox modes](https://code.claude.com/docs/en/sandboxing.md#sandbox-modes) to change this behavior.

## Managed settings

For organizations that need centralized control, administrators deploy managed settings that user and project settings can't override, apart from a few [security-sensitive keys](https://code.claude.com/docs/en/settings.md#exceptions-to-managed-settings-precedence). [Deploy managed settings](https://code.claude.com/docs/en/managed-settings.md) covers the delivery mechanisms, precedence within the managed tier, and the [keys that only managed settings can set](https://code.claude.com/docs/en/managed-settings.md#managed-only-settings).

One of those keys, [`allowManagedPermissionRulesOnly`](https://code.claude.com/docs/en/settings-reference#allowmanagedpermissionrulesonly), makes managed settings the only settings source of permission rules. Its entry lists every source Claude Code then ignores.

`disableBypassPermissionsMode` is typically placed in managed settings to enforce organizational policy, but it works from any scope. A user can set it in their own settings to lock themselves out of bypass mode.

## Settings precedence

Permission rules follow the same [settings precedence](https://code.claude.com/docs/en/settings.md#settings-precedence) as all other Claude Code settings, with managed settings highest: no other level, including command line arguments, can override a managed permission rule.

If a tool is denied at any level, no other level can allow it. For example, a managed settings deny can't be overridden by `--allowedTools`, and `--disallowedTools` can add restrictions beyond what managed settings define.

The same holds across settings scopes: if user settings allow a permission and project settings deny it, the deny rule blocks it. The reverse is also true: a user-level deny blocks a project-level allow, because deny rules from any scope are evaluated before allow rules.

This precedence is between settings files and command line arguments. For whether a deny rule holds over a [mod](https://code.claude.com/docs/en/plugins/mods/overview.md) you install, see [Extend permissions with hooks](#extend-permissions-with-hooks).

Embedding hosts can supply additional managed policy via the SDK `managedSettings` option, including permission allow rules unless the admin sets the `allowManaged*Only` locks; [Deliver policy to Claude Desktop sessions](https://code.claude.com/docs/en/claude-apps-gateway#deliver-policy-to-claude-desktop-sessions) covers when embedder policy applies at all.

## Project allow rules and workspace trust

`permissions.allow` rules and `permissions.additionalDirectories` entries in a project's `.claude/settings.json` grant capability, so Claude Code applies them only after you accept the [workspace trust dialog](https://code.claude.com/docs/en/security.md#additional-safeguards) for that folder. The dialog lists the rules and directories the folder would grant so you can review them first. `deny` and `ask` rules aren't affected, since they only restrict.

Claude Code keys and stores the trust you accept according to where you start it:

* In a repository, Claude Code keys the trust on the git repository root, so the trust covers the whole repository apart from any git repository nested inside it, such as a submodule. In a [worktree](https://code.claude.com/docs/en/worktrees.md), it uses the main checkout's root, as it does for [saved rules](#permission-system).
* Outside a repository, Claude Code keys the trust on the directory you started it from, and the trust covers any subdirectory of that directory apart from a git repository nested inside it, such as a clone. Each covered subdirectory then counts as a folder whose parent you trusted.
* When you start in your home directory, Claude Code holds the trust for the current session only and doesn't write it to disk; see the [additional safeguards](https://code.claude.com/docs/en/security.md#additional-safeguards) note.

Claude Code shows the trust dialog in interactive sessions only. A `claude -p` run or an SDK session never shows it, and trusting a parent folder doesn't count for these rules, so [What runs before you trust a folder](#what-runs-before-you-trust-a-folder) says which repository content Claude Code still uses in each of those two situations.

Before it starts or restarts a [background session](https://code.claude.com/docs/en/agent-view.md), Claude Code also checks workspace trust for the directory the session runs in. If you run `claude --bg` from a terminal in a directory you haven't trusted, the trust dialog appears first and the session starts once you accept it. Where no dialog can appear, such as in a script, the command exits with a [`Workspace not trusted`](https://code.claude.com/docs/en/errors#workspace-not-trusted-when-dispatching-a-background-session) error instead.

### When your local settings file needs trust

`.claude/settings.local.json` is normally your own file, so Claude Code applies its allow rules and additional directories without the trust step. When the file is tracked in git, or `.claude` is a symlink, Claude Code treats it as repository-supplied instead and holds its rules until you trust the folder.

Claude Code runs git to tell the two apart, and it runs git only once you've trusted the folder: you accepted the trust dialog for it or for a parent directory whose trust extends to it, or you're in a `-p` or SDK session, which counts as accepted. Until then, where you started Claude Code decides what happens to the file's rules:

* **In your configuration home:** Claude Code applies that folder's `.claude/settings.local.json` right away without running git. Your configuration home is your home directory, or a directory whose `.claude` subdirectory you've set as [`CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/env-vars#variables). If that `CLAUDE_CONFIG_DIR` directory sits inside a git repository and Claude Code [keeps your local settings at the repository root](https://code.claude.com/docs/en/settings.md#where-claude-code-looks-for-each-file) instead, it holds the rules like anywhere else.
* **Anywhere else:** Claude Code holds the file's rules like project settings. Once the check has run, Claude Code applies the rules of an untracked file, or of a file in a directory outside any git repository, even though you haven't trusted that exact folder.

> [!NOTE]
>
> The configuration-home exception skips only the trust step. `~/.claude/settings.local.json` is still [local scope](https://code.claude.com/docs/en/settings.md#compare-the-scope-of-each-settings-file), so Claude Code reads it only in sessions you start in your home directory itself, not in every project. To apply permission rules across all your projects, add them to your user settings instead: `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when `CLAUDE_CONFIG_DIR` is set.

### What runs before you trust a folder

Each row is one kind of content a repository can supply. The columns are the two situations in which you haven't trusted the folder itself: you trusted only a parent folder, or you ran `claude -p` or the SDK there, which never shows the trust dialog. The parent-folder column doesn't apply inside a [nested repository](#project-allow-rules-and-workspace-trust): in an interactive session Claude Code shows the trust dialog for it, and a `claude -p` or SDK run there follows the `claude -p` column.

| What the repository supplies | You trusted only a parent folder | `claude -p` or the SDK, folder never trusted |
| :- | :- | :- |
| [Hooks](https://code.claude.com/docs/en/hooks.md) in settings files, the [`env`](https://code.claude.com/docs/en/settings-reference#env) block and helper commands such as [`apiKeyHelper`](https://code.claude.com/docs/en/settings-reference#apikeyhelper), and a project skill's [hooks](https://code.claude.com/docs/en/hooks.md#hooks-in-skills-and-agents) and [`allowed-tools`](https://code.claude.com/docs/en/skills#pre-approve-tools-for-a-skill) | Used | Used. Workspace trust never gates a skill's `allowed-tools` in any session |
| `permissions.allow` rules and `additionalDirectories` in `.claude/settings.json` | Not used until you accept the trust dialog, which appears again listing them | Not used. Claude Code prints a [`this workspace has not been trusted`](https://code.claude.com/docs/en/errors#workspace-has-not-been-trusted) warning to stderr |
| Frontmatter hooks in a project [subagent](https://code.claude.com/docs/en/sub-agents.md#hooks-in-subagent-frontmatter), a project [`@skills-dir` plugin](https://code.claude.com/docs/en/plugins/loading#plugins-shared-through-a-repository), and [`extraKnownMarketplaces`](https://code.claude.com/docs/en/settings-reference#extraknownmarketplaces) entries from the repository or an `--add-dir` directory | Not used, and no dialog is offered | Not used |
| Inline [`mcpServers`](https://code.claude.com/docs/en/sub-agents#scope-mcp-servers-to-a-subagent) in the frontmatter of a subagent from the repository or an `--add-dir` directory | Not used, and no dialog is offered | Not used |
| Servers in `.mcp.json`, including ones the repository [approves in its own settings](https://code.claude.com/docs/en/mcp.md#project-server-approvals-and-workspace-trust) | Claude Code asks you before connecting them. The repository's own approvals don't count | Connected without asking, approved or not. The SDK loads them only when `settingSources` includes project settings. `claude mcp list` in the same folder still reports such a server as pending |
| A [`headersHelper`](https://code.claude.com/docs/en/mcp#trust-a-folder-before-its-headershelper-runs) on a server in `.mcp.json` | Not run until you accept the trust dialog, which appears again naming where the helper is declared. Claude Code connects the server with its static `headers` alone until then | Not run. Claude Code connects the server with its static `headers` alone and prints a [`headersHelper not run`](https://code.claude.com/docs/en/errors#headershelper-not-run) line per server to stderr |

For the rows that need this exact folder trusted, trust it by hand: set `projects["<path>"].hasTrustDialogAccepted` to `true` in `~/.claude.json`, where `<path>` is the repository root, or the folder itself outside a repository. Claude Code prints the exact key in the debug log line for a skipped subagent hook or inline MCP server, in the stderr warning for skipped allow rules, and in the `headersHelper not run` line for a skipped helper.

Before you run `claude -p` in a repository you didn't write, decide what it may run on your machine:

* Pass `--setting-sources user`, or set the SDK's `settingSources` without project settings, so Claude Code reads neither the project's settings files nor its `.mcp.json`
* Start with [`--bare`](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode) so Claude Code reads no hooks, skills, custom commands, subagents, plugins, or `.mcp.json` servers from the project. The project's `env` block and helpers such as `awsAuthRefresh` in its settings files still apply, and Claude Code reads `apiKeyHelper` only from `--settings`
* Pass `--settings '{"disableAllHooks": true}'` to [turn hooks off](https://code.claude.com/docs/en/hooks.md#disable-or-remove-hooks) for that run. Setting it in your user settings alone isn't enough, because the repository's project settings take precedence over yours and can set it back to `false`
* Add a [`disabledMcpjsonServers`](https://code.claude.com/docs/en/settings-reference#disabledmcpjsonservers) entry to reject a `.mcp.json` server by name in every session type

## Example configurations

This [repository](https://github.com/anthropics/claude-code/tree/main/examples/settings) includes starter settings configurations for common deployment scenarios. Use these as starting points and adjust them to fit your needs.

## See also

* [All settings](https://code.claude.com/docs/en/settings-reference.md#permission-settings): every settings key, including the permission keys
* [Configure auto mode](https://code.claude.com/docs/en/auto-mode-config.md): tell the auto mode classifier which infrastructure your organization trusts
* [Sandboxing](https://code.claude.com/docs/en/sandboxing.md): OS-level filesystem and network isolation for Bash commands
* [Authentication](https://code.claude.com/docs/en/authentication.md): set up user access to Claude Code
* [Security](https://code.claude.com/docs/en/security.md): security safeguards and best practices
* [Hooks](https://code.claude.com/docs/en/hooks-guide.md): automate workflows and extend permission evaluation
