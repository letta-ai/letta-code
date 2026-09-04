> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Run Claude Code programmatically

> Use the Agent SDK to run Claude Code programmatically from the CLI, Python, or TypeScript.

The [Agent SDK](/docs/en/agent-sdk/overview) gives you the same tools, agent loop, and context management that power Claude Code. It's available as a CLI for scripts and CI/CD, or as [Python](/docs/en/agent-sdk/python) and [TypeScript](/docs/en/agent-sdk/typescript) packages for full programmatic control.

To run Claude Code in non-interactive mode, pass `-p` with your prompt and the [CLI options](/docs/en/cli-reference) you need:

```bash theme={null}
claude -p "Find and fix the bug in auth.py" --allowedTools "Read,Edit,Bash"
```

This page covers using the Agent SDK via the CLI (`claude -p`). For the Python and TypeScript SDK packages with structured outputs, tool approval callbacks, and native message objects, see the [full Agent SDK documentation](/docs/en/agent-sdk/overview).

## Basic usage

Add the `-p` (or `--print`) flag to any `claude` command to run it non-interactively. Not every [CLI option](/docs/en/cli-reference) combines with `-p`. Claude Code rejects `--bg`, and rejects `--cloud` with a task description, with an error naming the conflict; `--cloud` with a session ID and `-p` instead [queues a message into that cloud session](/docs/en/claude-code-on-the-web#send-follow-ups-from-the-cli) and exits. Options you'll combine with `-p` often include:

* `--continue` for [continuing conversations](#continue-conversations)
* `--allowedTools` for [auto-approving tools](#auto-approve-tools)
* `--output-format` for [structured output](#get-structured-output)

This example asks Claude a question about your codebase and prints the response:

```bash theme={null}
claude -p "What does the auth module do?"
```

Claude Code exits with code 0 on success and a non-zero code when the run fails, so your scripts can branch on the exit status. If you pass an invalid flag, Claude Code reports the error to stderr before the run starts. When a failure happens inside the run, such as missing authentication, Claude Code prints the failure as the result on stdout.

### Start faster with bare mode

Add `--bare` to reduce startup time by skipping auto-discovery of hooks, skills, custom commands, [subagents](/docs/en/sub-agents), plugins, MCP servers, auto memory, and CLAUDE.md. Without it, `claude -p` loads the same [context](/docs/en/how-claude-code-works#the-context-window) an interactive session would, including anything configured in the working directory or `~/.claude`.

Bare mode is useful for CI and scripts where you need the same result on every machine. A hook in a teammate's `~/.claude` or an MCP server in the project's `.mcp.json` won't run, because bare mode never reads them. A directory you name with `--add-dir` is a partial exception: bare mode loads skills from its `.claude/skills/` folder, but still skips its `.claude/commands/` and `.claude/agents/` folders. [Skills from additional directories](/docs/en/skills#skills-from-additional-directories) covers what does and doesn't load.

Without `--bare`, a `-p` session runs the hooks in a project's `.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder you've never trusted. A `-p` session shows no workspace trust dialog and no per-server approval prompt. [What runs before you trust a folder](/docs/en/permissions#what-runs-before-you-trust-a-folder) covers each kind of repository content under `-p` and how to keep it out.

This example runs a one-off summarize task in bare mode and pre-approves the Read tool so the call completes without a permission prompt. Set `ANTHROPIC_API_KEY` before running it, because bare mode doesn't use your subscription login:

```bash theme={null}
claude --bare -p "Summarize README.md" --allowedTools "Read"
```

In bare mode, Claude Code never reads OAuth credentials or the system keychain. For the Anthropic API, set `ANTHROPIC_API_KEY` in the environment, with a key created in the [Claude Console](https://platform.claude.com), or supply an `apiKeyHelper` in the `--settings` JSON. Amazon Bedrock, Google Cloud's Agent Platform, and Microsoft Foundry continue to read their own provider credentials as usual.

In bare mode Claude has access to the Bash, file read, and file edit tools. Pass any context you need with a flag:

| To load                 | Use                                                     |
| ----------------------- | ------------------------------------------------------- |
| System prompt additions | `--append-system-prompt`, `--append-system-prompt-file` |
| Settings                | `--settings <file-or-json>`                             |
| MCP servers             | `--mcp-config <file-or-json>`                           |
| Custom agents           | `--agents <json>`                                       |
| A plugin                | `--plugin-dir <path>`, `--plugin-url <url>`             |

<Note>
  `--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release.
</Note>

### Background tasks at exit

If Claude starts a [background Bash task](/docs/en/tools-reference#bash-tool-behavior) during a `claude -p` run, for example a dev server or a watch build, that shell is terminated about five seconds after Claude has returned its final result and stdin has closed. The grace period lets a task that finishes right after the result still deliver its output. Before v2.1.163, a never-exiting background process would hold the `claude -p` invocation open indefinitely.

Background [subagents](/docs/en/sub-agents) and workflows are exempt from the five-second grace because their result is part of the final output, so `claude -p` waits for them to complete. From v2.1.182, that wait is capped at ten minutes of continuous idle waiting by default, so a stuck background agent can't hold the process open indefinitely. Adjust the cap with [`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`](/docs/en/env-vars), or set it to `0` to wait without a limit.

### Stop a run with SIGTERM

If you stop a `claude -p` run with SIGTERM, for example with `kill` or from a process supervisor, Claude Code exits with code 143. Claude Code leaves the turn that was in progress unfinished and records no result for it. To end the turn instead, send SIGINT, or call the Agent SDK's `interrupt()`, before you stop the process.

On SIGTERM, Claude Code terminates the process tree of any Bash command that is still running. Claude Code then runs [`SessionEnd` hooks](/docs/en/hooks#sessionend) and exits. While exiting, Claude Code starts no new tool call, sends no new model request, and runs no hook other than `SessionEnd`. If the run was in the middle of a command or waiting on a permission prompt when the signal arrived, Claude Code handles that step as follows:

* **Running a command**: Claude Code records the command as killed in the session.
* **Waiting for an answer to a permission prompt**: if you send SIGTERM to the process, Claude Code leaves the prompt unanswered. If your program closes the session through the Agent SDK, the SDK ends Claude Code's input before sending any signal, and Claude Code cancels the prompt as soon as the input ends.

When you [resume the session](#continue-conversations), Claude Code continues the turn that SIGTERM left unfinished.

## Examples

These examples highlight common CLI patterns. Where a command names a file such as `auth.py` or `build-error.txt`, substitute a file from your own project. In CI or other scripted environments, add [`--bare`](#start-faster-with-bare-mode) so Claude Code starts without loading the host's hooks, plugins, auto memory, or `CLAUDE.md`.

### Pipe data through Claude

Non-interactive mode reads stdin, so you can pipe data in and redirect the response out like any other command-line tool.

This example pipes a build log into Claude and writes the explanation to a file:

```bash theme={null}
cat build-error.txt | claude -p 'concisely explain the root cause of this build error' > output.txt
```

With `--output-format json`, the response payload includes `total_cost_usd` and a per-model cost breakdown, so scripted callers can track spend per invocation without consulting the [usage dashboard](/docs/en/costs). Both figures are [client-side estimates](/docs/en/agent-sdk/cost-tracking) and can differ from your actual bill.

<Note>
  Piped stdin is capped at 10MB. If you exceed the cap, Claude Code exits with a clear error and a non-zero status. To work with larger inputs, write the content to a file and reference the file path in your prompt instead of piping it.
</Note>

If Claude Code can't read stdin, for example because the process that started it disconnected its end, Claude Code prints a warning to stderr and continues with the prompt from the command line. Before v2.1.211, an unreadable stdin on Windows crashed the session or made it exit silently with no output.

### Add Claude to a build script

You can wrap a non-interactive call in a script to use Claude as a project-specific linter or reviewer.

This `package.json` script pipes the diff against `main` into Claude and asks it to report typos. Piping the diff means Claude doesn't need Bash permission to read it, and the escaped double quotes keep the script portable to Windows:

```json theme={null}
{
  "scripts": {
    "lint:claude": "git diff main | claude -p \"you are a typo linter. for each typo in this diff, report filename:line on one line and the issue on the next. return nothing else.\""
  }
}
```

Run it with `npm run lint:claude`.

### Get structured output

Use `--output-format` to control how responses are returned:

* `text` (default): plain text output
* `json`: structured JSON with result, session ID, and metadata
* `stream-json`: newline-delimited JSON for real-time streaming

This example returns a project summary as JSON with session metadata, with the text result in the `result` field:

```bash theme={null}
claude -p "Summarize this project" --output-format json
```

To get output conforming to a specific schema, use `--output-format json` with `--json-schema` and a [JSON Schema](https://json-schema.org/) definition. The response includes metadata about the request (session ID, usage, etc.) with the structured output in the `structured_output` field.

This example extracts function names and returns them as an array of strings:

```bash theme={null}
claude -p "Extract the main function names from auth.py" \
  --output-format json \
  --json-schema '{"type":"object","properties":{"functions":{"type":"array","items":{"type":"string"}}},"required":["functions"]}'
```

If the value isn't a valid JSON Schema, `claude` exits with `Error: --json-schema is not a valid JSON Schema` followed by the validator's diagnostic. Claude Code accepts schemas that use the `format` keyword, such as `"format": "email"`, but treats `format` as an annotation and doesn't enforce it. Before v2.1.205, Claude Code silently ignored an invalid schema and returned unstructured text, and treated any schema containing `format` as invalid.

<Tip>
  Use a tool like [jq](https://jqlang.org/) to parse the response and extract specific fields:

  ```bash theme={null}
  # Extract the text result
  claude -p "Summarize this project" --output-format json | jq -r '.result'

  # Extract structured output
  claude -p "Extract function names from auth.py" \
    --output-format json \
    --json-schema '{"type":"object","properties":{"functions":{"type":"array","items":{"type":"string"}}},"required":["functions"]}' \
    | jq '.structured_output'
  ```
</Tip>

### Stream responses

Use `--output-format stream-json` with `--verbose` and `--include-partial-messages` to receive tokens as they're generated. Each line is a JSON object representing an event:

```bash theme={null}
claude -p "Explain recursion" --output-format stream-json --verbose --include-partial-messages
```

The last line of the stream is a `result` message with the final response text, cost, and session metadata.

If your consumer reads the stream slowly, Claude Code waits for the queued output to drain before exiting, scaling the wait with how much is still queued, capped at 30 seconds. Before v2.1.214 the exit wait was capped at about two seconds, which could cut off the end of a large response.

The following example uses [jq](https://jqlang.org/) to filter for text deltas and display just the streaming text. The `-r` flag outputs raw strings (no quotes) and `-j` joins without newlines so tokens stream continuously:

```bash theme={null}
claude -p "Write a poem" --output-format stream-json --verbose --include-partial-messages | \
  jq -rj 'select(.type == "stream_event" and .event.delta.type? == "text_delta") | .event.delta.text'
```

For programmatic streaming with callbacks and message objects, see [Stream responses in real-time](/docs/en/agent-sdk/streaming-output) in the Agent SDK documentation.

#### Follow subagent messages

Messages from [subagents](/docs/en/sub-agents) appear in the stream as `assistant` and `user` messages whose `parent_tool_use_id` field is the ID of the tool call that spawned the subagent. Messages from the main conversation carry `null` in that field.

By default, Claude Code emits only subagent `tool_use` and `tool_result` blocks. Pass [`--forward-subagent-text`](/docs/en/cli-reference#cli-flags) or set [`CLAUDE_CODE_FORWARD_SUBAGENT_TEXT`](/docs/en/env-vars) to also emit subagent text and thinking blocks, so you can reconstruct each subagent's transcript. This requires Claude Code v2.1.211 or later.

When you enable either option, Claude Code forwards messages from [subagents at every nesting depth](/docs/en/sub-agents#let-subagents-spawn-their-own-subagents): when a subagent spawns its own subagent, the nested subagent's messages carry the ID of the Agent tool call that spawned it in `parent_tool_use_id`, so you can rebuild the full nesting tree by following those IDs. Before v2.1.219, messages from nested subagents didn't appear in the stream.

#### Handle API retries

When an API request fails with a retryable error, Claude Code emits a `system/api_retry` event before retrying. On v2.1.246 or later, when a `401` or `403` rejects an [`apiKeyHelper`](/docs/en/settings-reference#apikeyhelper) credential, Claude Code makes the first two retries quietly with no event, then emits the event as usual from the third consecutive retry onward. The quiet retries still count toward `attempt`. You can use the event to show retry progress in your own interface.

| Field            | Type            | Description                                                                                                                                                                                            |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`           | `"system"`      | message type                                                                                                                                                                                           |
| `subtype`        | `"api_retry"`   | identifies this as a retry event                                                                                                                                                                       |
| `attempt`        | integer         | current attempt number, starting at 1                                                                                                                                                                  |
| `max_retries`    | integer         | total retries permitted                                                                                                                                                                                |
| `retry_delay_ms` | integer         | milliseconds until the next attempt                                                                                                                                                                    |
| `error_status`   | integer or null | HTTP status code, or `null` for connection errors with no HTTP response                                                                                                                                |
| `error`          | string          | error category: `authentication_failed`, `oauth_org_not_allowed`, `billing_error`, `rate_limit`, `overloaded`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, or `unknown` |
| `uuid`           | string          | unique event identifier                                                                                                                                                                                |
| `session_id`     | string          | session the event belongs to                                                                                                                                                                           |

#### Read session metadata

The `system/init` event reports session metadata including the model, tools, MCP servers, and loaded plugins. It is the first event in the stream unless startup events precede it:

* `plugin_install` events, when [`CLAUDE_CODE_SYNC_PLUGIN_INSTALL`](/docs/en/env-vars) is set.
* [`hook_started`, `hook_progress`, and `hook_response` events](/docs/en/agent-sdk/typescript#sdkhookstartedmessage), while a configured [`SessionStart`](/docs/en/hooks#sessionstart) or [`Setup`](/docs/en/hooks#setup) hook runs. These stream as the hook produces them. Claude Code v2.1.169 through v2.1.203 delivered them in one batch after the hook completed, still ahead of `system/init`; v2.1.204 restored live delivery.

The event also carries an optional `capabilities` array of strings naming the protocol behaviors this Claude Code version implements, such as `interrupt_receipt_v1` or `interrupt_cancel_queued_v1`. Check it to feature-detect instead of comparing version strings, and ignore values you don't recognize. The field requires Claude Code v2.1.205 or later and is absent from earlier versions. See [`SDKSystemMessage`](/docs/en/agent-sdk/typescript#sdksystemmessage) for the capability list.

#### Fail CI when a plugin or MCP server doesn't load

Use the plugin fields in the `system/init` event to catch a plugin that didn't load:

| Field           | Type  | Description                                                                                                                                                                                                                                                                                  |
| --------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins`       | array | plugins that loaded successfully, each with `name` and `path`                                                                                                                                                                                                                                |
| `plugin_errors` | array | plugin load-time errors, each with `plugin`, `type`, and `message`. Includes unsatisfied dependency versions and `--plugin-dir` load failures such as a missing path or invalid archive. Affected plugins are demoted and absent from `plugins`. The key is omitted when there are no errors |

Use the MCP server fields the same way. When you pass [`--mcp-config`](/docs/en/cli-reference#cli-flags) with `-p`, Claude Code waits for still-pending servers before running the first turn, up to the [`MCP_TIMEOUT`](/docs/en/env-vars) startup timeout, 30 seconds by default. A remote server with a [cached tool list](/docs/en/agent-sdk/mcp#connection-timing) skips the wait, shows `pending` in `system/init`, and connects on its first tool call. The wait requires Claude Code v2.1.221 or later.

Claude Code validates each `--mcp-config` entry at startup and skips entries that fail validation, for example a `url` entry with no `type`. The run continues and exits cleanly, so check these fields to catch a server that never loaded:

| Field               | Type  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp_servers`       | array | MCP servers in the session, each with `name` and `status`                                                                                                                                                                                                                                                                                                                                                                                     |
| `mcp_server_errors` | array | `--mcp-config` entries skipped by config validation, each with `name`, `type`, and `message`. `type` is a skip category such as `unknown_type`, `url_missing_type`, `invalid_config`, or `reserved_name`; treat values you don't recognize as a generic skip. Affected servers are absent from `mcp_servers`. The key is omitted when there are no errors, so a CI gate can fail on a non-empty array. Requires Claude Code v2.1.219 or later |

When you run the command by hand in a terminal, Claude Code also prints a startup warning to stderr, such as `Warning: 1 MCP server skipped due to invalid config:`, followed by the reason for each skipped entry. When you redirect stderr, or when a program such as a CI runner or an SDK host captures it, Claude Code prints no warning and reports the skipped entries only in the `mcp_server_errors` field. The warning requires Claude Code v2.1.219 or later.

#### Track plugin installs

When [`CLAUDE_CODE_SYNC_PLUGIN_INSTALL`](/docs/en/env-vars) is set, Claude Code emits `system/plugin_install` events while marketplace plugins install before the first turn. Use these to surface install progress in your own UI.

| Field        | Type                                                     | Description                                                                                                    |
| ------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `type`       | `"system"`                                               | message type                                                                                                   |
| `subtype`    | `"plugin_install"`                                       | identifies this as a plugin install event                                                                      |
| `status`     | `"started"`, `"installed"`, `"failed"`, or `"completed"` | `started` and `completed` bracket the overall install; `installed` and `failed` report individual marketplaces |
| `name`       | string, optional                                         | marketplace name, present on `installed` and `failed`                                                          |
| `error`      | string, optional                                         | failure message, present on `failed`                                                                           |
| `uuid`       | string                                                   | unique event identifier                                                                                        |
| `session_id` | string                                                   | session the event belongs to                                                                                   |

### Auto-approve tools

Use `--allowedTools` to let Claude use certain tools without prompting. This example runs a test suite and fixes failures, allowing Claude to execute Bash commands and read/edit files without asking for permission:

```bash theme={null}
claude -p "Run the test suite and fix any failures" \
  --allowedTools "Bash,Read,Edit"
```

To set a baseline for the whole session instead of listing individual tools, pass a [permission mode](/docs/en/permission-modes). For `-p`, the [built-in starting permission mode](/docs/en/permission-modes#which-mode-a-session-starts-in) is Manual on every plan, so pass the permission mode you want:

* **`auto`**: pass `--permission-mode auto` to have a classifier review most actions instead of you
* **`dontAsk`**: Claude Code denies anything not in your `permissions.allow` rules or the [read-only command set](/docs/en/permissions#read-only-commands), which is useful for locked-down CI runs. `AskUserQuestion`, connector tools [your organization set to `ask`](/docs/en/mcp#organization-controls-on-connector-tools), and MCP tools marked [`requiresUserInteraction`](/docs/en/mcp#require-approval-for-a-specific-tool) are denied even when an allow rule matches
* **`acceptEdits`**: Claude writes files without prompting, and Claude Code auto-approves common filesystem commands such as `mkdir`, `touch`, `mv`, and `cp`. The [actions no mode auto-approves](/docs/en/permission-modes#actions-no-mode-auto-approves) still apply. Apart from the read-only command set, other shell commands and network requests still need an `--allowedTools` entry or a `permissions.allow` rule. See [what `acceptEdits` auto-approves](/docs/en/permission-modes#auto-approve-file-edits-with-acceptedits-mode) for the full list

This example applies lint fixes with `acceptEdits` as the baseline:

```bash theme={null}
claude -p "Apply the lint fixes" --permission-mode acceptEdits
```

### Turn off permission prompts in unattended runs

Pass `--permission-prompts none` when nobody is available to answer permission prompts, for example in a scheduled job. The flag matters most when your run has a permission host: an Agent SDK app with a [`canUseTool` callback](/docs/en/agent-sdk/user-input), or an MCP tool you pass with [`--permission-prompt-tool`](/docs/en/cli-reference#cli-flags). Without the flag, your run waits for that host to answer each permission request.

With the flag, your run doesn't consult the host or wait on it. Anything that would prompt is denied unless a `PermissionRequest` hook allows it, Claude is told that nobody can approve the request and not to retry it, and the run continues. In a `-p` run with no host, these requests are denied either way, and the flag also tells Claude not to retry them. Permission rules, [`PermissionRequest` hooks](/docs/en/hooks#permissionrequest), and the permission mode you set still decide every call first; Claude Code denies only the requests that nothing else resolves.

This example runs an unattended task in [auto mode](/docs/en/permission-modes#eliminate-prompts-with-auto-mode). The classifier reviews each action as usual, and Claude Code denies anything that would have fallen back to a prompt:

```bash theme={null}
claude -p "Update the dependency pins and run the tests" --permission-mode auto --permission-prompts none
```

With `--permission-prompts none`, Claude Code removes the tools that need an answer from a person, such as [`AskUserQuestion`](/docs/en/tools-reference#askuserquestion-tool-behavior), so Claude can't call them. Any [MCP elicitation request](/docs/en/mcp#respond-to-mcp-elicitation-requests) that no [`Elicitation` hook](/docs/en/hooks#elicitation) answers is cancelled.

With `--output-format stream-json`, denials appear as `permission_denied` system messages, and the final result message lists them in `permission_denials`.

<Note>
  The `--permission-prompts` flag requires Claude Code v2.1.259 or later. Earlier versions reject it with an unknown-option error.
</Note>

### Create a commit

This example reviews staged changes and creates a commit with an appropriate message:

```bash theme={null}
claude -p "Look at my staged changes and create an appropriate commit" \
  --allowedTools "Bash(git diff *),Bash(git log *),Bash(git status *),Bash(git commit *)"
```

The `--allowedTools` flag uses [permission rule syntax](/docs/en/settings-reference#permission-rule-syntax). The trailing ` *` enables prefix matching, so `Bash(git diff *)` allows any command starting with `git diff`. The space before `*` is important: without it, `Bash(git diff*)` would also match `git diff-index`.

<Note>
  User-invoked [skills](/docs/en/skills) and custom commands work in `-p` mode: include `/skill-name` in the prompt string and Claude Code expands it before running. Built-in commands that only run in the terminal interface, such as `/login`, aren't available in `-p` mode. `/model`, `/effort`, `/fast`, `/color`, and `/rename` accept the value as an argument, for example `/model sonnet`, and `/mcp` with no argument prints a text summary of server status; these forms require Claude Code v2.1.205 or later and follow each command's [availability notes](/docs/en/commands#all-commands). To change a setting from a `-p` invocation, pass `key=value` to `/config`, for example `/config thinking=false`.
</Note>

### Customize the system prompt

Use `--append-system-prompt` to add instructions while keeping Claude Code's default behavior. This example pipes a PR diff to Claude and instructs it to review for security vulnerabilities. Save it as a shell script, for example `review.sh`:

```bash theme={null}
gh pr diff "$1" | claude -p \
  --append-system-prompt "You are a security engineer. Review for vulnerabilities." \
  --output-format json
```

In the script, `"$1"` stands for the first argument you pass on the command line. Run `bash review.sh 123` and the shell replaces `"$1"` with `123`, so the script fetches the diff for PR 123. Claude Code prints the review as JSON, with the text in the `result` field.

See [system prompt flags](/docs/en/cli-reference#system-prompt-flags) for more options including `--system-prompt` to fully replace the default prompt.

### Continue conversations

Use `--continue` to continue the most recent conversation, or `--resume` with a session ID to continue a specific conversation. `--continue` skips [background sessions](/docs/en/sessions#resume-a-session). This example runs a review, then sends follow-up prompts:

```bash theme={null}
# First request
claude -p "Review this codebase for performance issues"

# Continue the most recent conversation
claude -p "Now focus on the database queries" --continue
claude -p "Generate a summary of all issues found" --continue
```

If you're running multiple conversations, capture the session ID to resume a specific one:

```bash theme={null}
session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')
claude -p "Continue that review" --resume "$session_id"
```

You can run the two commands from different directories: Claude Code [finds the session by its ID](/docs/en/sessions#resume-a-session) in any project on this machine. Before v2.1.223, Claude Code looked for the ID only in the current project directory and its git worktrees, so you had to run both commands from the same directory.

## Next steps

* [Agent SDK quickstart](/docs/en/agent-sdk/quickstart): build your first agent with Python or TypeScript
* [CLI reference](/docs/en/cli-reference): all CLI flags and options
* [GitHub Actions](/docs/en/github-actions): use the Agent SDK in GitHub workflows
* [GitLab CI/CD](/docs/en/gitlab-ci-cd): use the Agent SDK in GitLab pipelines
