> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Recommend your plugin from your CLI

> Prompt Claude Code users to install your official-marketplace plugin by emitting a claude-code-hint tag from your CLI or SDK.

If you maintain a CLI or SDK, your tool can prompt Claude Code users to install your plugin. When your CLI detects that it's running inside Claude Code, have it write a one-line `<claude-code-hint />` tag to stderr. Claude Code removes the line from Bash and PowerShell tool output before the model sees the output, then shows the user a one-time install prompt.

This page applies only if your plugin is listed in `claude-plugins-official` or another marketplace with one of Anthropic's [official marketplace names](/docs/en/plugins/security#official-marketplace-names). The community marketplace, `claude-community`, isn't one of them.

<Note>
  To publish a plugin, see [Publish and distribute a plugin](/docs/en/plugins/publish).
</Note>

## Emit the hint

Emit the tag only when `CLAUDECODE` or `CLAUDE_CODE_CHILD_SESSION` is set, so it doesn't appear when a person runs your CLI directly.

Claude Code sets `CLAUDECODE=1` in the commands it runs through the Bash and PowerShell tools and in hook commands. On v2.1.172 and later it also sets `CLAUDE_CODE_CHILD_SESSION=1` there. The variables differ in which processes carry them:

* **`CLAUDECODE`**: set by every Claude Code version. IDE extensions also set it in their integrated terminals, so a gate on `CLAUDECODE` alone also emits the tag when a person runs your CLI themselves in one of those terminals
* **`CLAUDE_CODE_CHILD_SESSION`**: set only in subprocesses Claude Code itself starts. Use it when you can require v2.1.172 or later

The [environment variables reference](/docs/en/env-vars) has the details.

The following examples gate on `CLAUDECODE` for the widest reach and emit a hint for a plugin named `example-cli` in the official marketplace:

<CodeGroup>
  ```javascript Node.js theme={null}
  if (process.env.CLAUDECODE) {
    process.stderr.write(
      '<claude-code-hint v="1" type="plugin" value="example-cli@claude-plugins-official" />\n',
    )
  }
  ```

  ```python Python theme={null}
  import os, sys

  if os.environ.get("CLAUDECODE"):
      print(
          '<claude-code-hint v="1" type="plugin" value="example-cli@claude-plugins-official" />',
          file=sys.stderr,
      )
  ```

  ```go Go theme={null}
  if os.Getenv("CLAUDECODE") != "" {
      fmt.Fprintln(os.Stderr,
          `<claude-code-hint v="1" type="plugin" value="example-cli@claude-plugins-official" />`)
  }
  ```

  ```shell Shell theme={null}
  if [ -n "$CLAUDECODE" ]; then
    printf '%s\n' '<claude-code-hint v="1" type="plugin" value="example-cli@claude-plugins-official" />' >&2
  fi
  ```
</CodeGroup>

Replace `example-cli` with your plugin's name in the official marketplace.

You can emit the hint on every invocation, because Claude Code prompts for each plugin once.

To check the emitter, run `CLAUDECODE=1 example-cli` in a terminal and confirm the tag line appears on stderr, then run `example-cli` without the variable and confirm nothing extra prints.

## Hint format

The tag must occupy its own line; Claude Code ignores a tag embedded mid-line.

The tag takes three attributes, all required:

| Attribute | Description                                       |
| :-------- | :------------------------------------------------ |
| `v`       | Protocol version. `1` is the only supported value |
| `type`    | Hint kind. `plugin` is the only supported value   |
| `value`   | Plugin identifier in `name@marketplace` form      |

Values may be double-quoted or unquoted; an unquoted value can't contain whitespace.

Claude Code removes the line from the output even when `v` or `type` is unrecognized.

## Check when the prompt appears

The prompt appears only in interactive terminal sessions. In `claude -p` runs, in subagent runs, and in hook command output, the tag is stripped and no prompt is shown. All of these checks must also pass:

* **Official and installable**: `value` names a plugin that Claude Code finds in its local copy of an official marketplace, that isn't already installed, and that no policy blocks
* **Analytics on**: a session where Claude Code's analytics are off never prompts, for example one with `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set, or one on a third-party provider such as Amazon Bedrock, where the [automatic telemetry opt-out](/docs/en/data-usage#default-behaviors-by-api-provider) applies
* **Frequency limits**: one prompt per session, one prompt ever per plugin regardless of the user's answer, and none once 100 plugins have been prompted for on that machine
* **Not turned off**: the user hasn't chosen **No, and don't show plugin installation hints again**
* **Local, attended session**: the session's workspace is local rather than on a cloud or remote machine, and the session isn't running unattended. For example, a session started with `--cloud`, one serving Remote Control, or an agent-team teammate never prompts

## Preview what the user sees

When the checks in [Check when the prompt appears](#check-when-the-prompt-appears) pass, Claude Code shows a **Plugin recommendation** dialog like the following:

```text theme={null}
─────────────────────────────────────────────────────────────
  Plugin recommendation

    The example-cli command suggests installing a plugin.

    Plugin: example-cli
    Marketplace: claude-plugins-official
    Description: Official integration for example-cli deployments

    Would you like to install it?
    ❯ 1. Yes, install
      2. No
      3. No, and don't show plugin installation hints again

─────────────────────────────────────────────────────────────
```

The dialog names the first word of the shell command Claude ran, so users can spot a mismatch. Each answer has one effect:

* **Yes, install**: installs the plugin at [user scope](/docs/en/plugins/install)
* **No, and don't show plugin installation hints again**: turns off future hint prompts for that user
* **No answer for 30 seconds**: counts as **No**

## Next steps

* [Publish and distribute a plugin](/docs/en/plugins/publish): the routes for distributing a plugin, including the official marketplace, which the hint requires
* [Plugin commands reference](/docs/en/plugins/cli-reference#plugin-install): the shell command that installs the same plugin outside a session
