> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Extend agents with skills

> Control which skills Claude can invoke in Claude Agent SDK sessions, dispatch commands by name, and author skills your sessions discover

Agent Skills extend Claude with specialized capabilities that Claude invokes when relevant. Skills are packaged as `SKILL.md` files containing instructions, descriptions, and optional supporting resources. This page also covers [commands in Agent SDK sessions](#commands-in-agent-sdk-sessions).

For comprehensive information about skills, including benefits, architecture, and authoring guidelines, see the [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview).

## How skills work with the Agent SDK

When using the Claude Agent SDK, skills are:

* **Defined as filesystem artifacts**: you create each skill as a `SKILL.md` file in its own directory, such as `.claude/skills/<name>/SKILL.md`
* **Loaded from filesystem**: the SDK loads skills from the filesystem locations governed by `settingSources` (TypeScript) or `setting_sources` (Python)
* **Automatically discovered**: once filesystem settings load, the SDK discovers skill metadata at startup from user and project directories, and loads the full content when Claude invokes the skill
* **Model-invoked**: Claude autonomously chooses when to use them based on context
* **User-invoked**: you dispatch a skill directly by sending `/<name>` in a prompt. See [Commands in Agent SDK sessions](#commands-in-agent-sdk-sessions)
* **Scoped via the `skills` option**: discovered skills are enabled by default. Pass a list of skill names, `"all"`, or `[]` to control which skills Claude can invoke

Unlike subagents, which you can define in the [`agents` option](/docs/en/agent-sdk/subagents#programmatic-definition-recommended), you create skills as files on disk. The SDK doesn't provide a programmatic API for registering them.

<Note>
  Skills are discovered through the filesystem setting sources. With default `query()` options, the SDK loads user and project sources, so skills in `~/.claude/skills/`, `<cwd>/.claude/skills/`, and `.claude/skills/` in any parent directory of `<cwd>` up to the repository root are available. The project source also covers `<dir>/.claude/skills/` in each directory you pass through `additionalDirectories` (TypeScript) or `add_dirs` (Python), because the SDK passes those directories to Claude Code as [`--add-dir`](/docs/en/skills#skills-from-additional-directories). If you set `settingSources` explicitly, include `'project'` to keep project and added-directory skills and `'user'` to keep your personal skills, or use the [`plugins` option](/docs/en/agent-sdk/plugins) to load skills from a specific path.
</Note>

## Use skills with the Agent SDK

Set the `skills` option on `query()` to control which skills Claude can invoke in the session. When omitted, discovered skills are enabled and the Skill tool is available, matching CLI behavior. Pass `"all"` to let Claude invoke every discovered skill, a list of skill names to allow only those, or `[]` to let Claude invoke none.

For example, to let Claude invoke only two named skills:

<CodeGroup>
  ```python Python theme={null}
  options = ClaudeAgentOptions(skills=["pdf", "docx"])
  ```

  ```typescript TypeScript theme={null}
  const options = { skills: ["pdf", "docx"] };
  ```
</CodeGroup>

### Set up skills in a session

When you set `skills`, the SDK adds the Skill tool to `allowedTools` automatically. If you also pass an explicit `tools` list, include `"Skill"` in that list so Claude can invoke skills.

Once configured, Claude automatically discovers skills from the filesystem and invokes them when relevant to the user's request.

The following example enables every discovered skill in a session and pre-approves the tools that skills commonly need. The example sets `cwd` to the process's current working directory, so run it from inside a project that has a `.claude/skills/` directory in the current directory or any parent up to the repository root:

<CodeGroup>
  ```python Python theme={null}
  import asyncio
  import os

  from claude_agent_sdk import query, ClaudeAgentOptions


  async def main():
      options = ClaudeAgentOptions(
          cwd=os.getcwd(),  # .claude/skills/ here or in a parent directory
          setting_sources=["user", "project"],  # Load skills from filesystem
          skills="all",  # Let Claude invoke every discovered skill
          allowed_tools=["Read", "Write", "Bash"],
      )

      async for message in query(
          prompt="Help me process this PDF document", options=options
      ):
          print(message)


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  for await (const message of query({
    prompt: "Help me process this PDF document",
    options: {
      cwd: process.cwd(), // .claude/skills/ here or in a parent directory
      settingSources: ["user", "project"], // Load skills from filesystem
      skills: "all", // Let Claude invoke every discovered skill
      allowedTools: ["Read", "Write", "Bash"]
    }
  })) {
    console.log(message);
  }
  ```
</CodeGroup>

### Confirm skills loaded

Near the start of the stream, the SDK yields a system message with subtype `init`. Check its `skills` array to confirm your skills loaded before Claude starts working. The array includes the user-invocable skills that you have defined, along with [bundled skills included with Claude Code](/docs/en/skills#bundled-skills).

The array lists user-invocable skills only. A skill with [`user-invocable: false`](/docs/en/skills#control-who-invokes-a-skill) in its frontmatter loads and remains available to Claude, but doesn't appear in the array. The array reflects what the session discovered and lists the same skills whether or not they're in your `skills` list.

### Allow only specific skills

To let Claude invoke only specific skills, pass their names in the `skills` list. Names match the `name` field in `SKILL.md` or the skill's directory name. Use `plugin:skill` for plugin-provided skills.

The list takes exact skill names only. If an entry can't work as an exact name, `query()` rejects the list before the session starts. See [Invalid skill name error](#invalid-skill-name-error) for the name rules and the error each SDK raises.

The model doesn't see unlisted skills and the Skill tool rejects them, while their files remain on disk and stay reachable through Read and Bash. Restricting the list doesn't restrict [dispatch by name](#dispatch-commands-by-name).

To let Claude invoke every discovered skill, pass `skills: "all"` rather than a wildcard.

## Commands in Agent SDK sessions

This section is the SDK's command documentation. A command is anything you run by sending `/<name>` in a prompt. Entries on the command surface differ in what backs them:

* **Built-in commands**: execute logic coded into the Claude Code process the SDK runs, for example `/compact`
* **Bundled skills**: prompt artifacts included with Claude Code, for example `/code-review`
* **Your skills**: prompt artifacts that you author, each a directory holding a `SKILL.md` file. A user-invocable skill's name joins the surface automatically, so dispatching your own `/security-check` and running a built-in work the same way
* **Custom command files**: an older artifact form with the same behavior, flat Markdown files in `.claude/commands/` whose filenames become command names. Skills are their recommended successor

By default, both you and Claude can invoke any skill. You can restrict either path through the skill's [frontmatter](/docs/en/skills#control-who-invokes-a-skill). For a definition of the two terms, see the glossary's [Command](/docs/en/glossary#command) and [Skill](/docs/en/glossary#skill) entries. See [Commands in Claude Code](/docs/en/commands) for every built-in and [Extend Claude with skills](/docs/en/skills) for the complete guide to both artifact forms.

### Discover available commands

You can dispatch commands that work without an interactive terminal through the SDK. The `system/init` message lists the ones available in your session in its `slash_commands` field. Commands that need an interactive terminal, such as `/theme` and `/terminal-setup`, don't appear in the list. Access the field when your session starts:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  for await (const message of query({
    prompt: "Hello Claude",
    options: { maxTurns: 1 }
  })) {
    if (message.type === "system" && message.subtype === "init") {
      console.log("Available commands:", message.slash_commands);
    }
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, SystemMessage


  async def main():
      async for message in query(prompt="Hello Claude", options=ClaudeAgentOptions(max_turns=1)):
          if isinstance(message, SystemMessage) and message.subtype == "init":
              print("Available commands:", message.data["slash_commands"])


  asyncio.run(main())
  ```
</CodeGroup>

The printed list mixes built-in commands, bundled skills, your user-invocable skills, and `.claude/commands/` files:

```text theme={null}
Available commands: ["clear", "compact", "context", "usage", "code-review", "verify", "security-check", ...]
```

Your user-invocable skills appear in both this list and the `skills` array from [Confirm skills loaded](#confirm-skills-loaded). The `slash_commands` list adds the rest of the commands available in your session. A skill with [`user-invocable: false`](/docs/en/skills#control-who-invokes-a-skill) in its frontmatter doesn't appear in either. Sessions that configure [MCP servers](/docs/en/agent-sdk/mcp) can also expose [MCP prompts as commands](/docs/en/mcp#use-mcp-prompts-as-commands).

### Dispatch commands by name

Send a command by including it in your prompt string, the same way you send regular text. Dispatch doesn't depend on the `skills` option. Sending `/<name>` runs a user-invocable skill even when your `skills` list omits it. Commands that act on conversation history, such as `/compact`, need prior messages to work with.

<Note>
  A command can hit the `maxTurns` / `max_turns` limit like any other prompt, ending the query with an error result instead of `success`. For the error-result contract, see [Handle the result](/docs/en/agent-sdk/agent-loop#handle-the-result). If your command might hit the limit, wrap the loop in a `try`/`catch` in TypeScript or `try`/`except` in Python, as shown in [Single Message Input](/docs/en/agent-sdk/streaming-vs-single-mode#single-message-input), or set `maxTurns` high enough for the work to complete.
</Note>

### Compact history with `/compact`

The `/compact` command reduces the size of your conversation history by summarizing older messages while preserving important context. Compaction needs an existing conversation with enough prior messages to summarize. This example has a conversation first, then compacts it and reads the `compact_boundary` system message that reports the result:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  // Compaction needs existing history, so have a conversation first
  try {
    for await (const message of query({
      prompt: "Explain what this project does",
      options: { maxTurns: 2 }
    })) {
      if (message.type === "result" && message.subtype === "success") {
        console.log(message.result);
      }
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result,
    // so the follow-up query below still runs.
    console.error(`Session ended with an error: ${error}`);
  }

  // Compact the same conversation
  for await (const message of query({
    prompt: "/compact",
    options: { continue: true, maxTurns: 1 }
  })) {
    if (message.type === "system" && message.subtype === "compact_boundary") {
      console.log("Compaction completed");
      console.log("Pre-compaction tokens:", message.compact_metadata.pre_tokens);
      console.log("Trigger:", message.compact_metadata.trigger);
      // Example output:
      // Compaction completed
      // Pre-compaction tokens: 1842
      // Trigger: manual
    }
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage, SystemMessage


  async def main():
      # Compaction needs existing history, so have a conversation first
      try:
          async for message in query(
              prompt="Explain what this project does",
              options=ClaudeAgentOptions(max_turns=2),
          ):
              if isinstance(message, ResultMessage) and message.subtype == "success":
                  print(message.result)
      except Exception as error:
          # A single-shot query() raises after yielding an error result,
          # so the follow-up query below still runs.
          print(f"Session ended with an error: {error}")

      # Compact the same conversation
      async for message in query(
          prompt="/compact",
          options=ClaudeAgentOptions(continue_conversation=True, max_turns=1),
      ):
          if isinstance(message, SystemMessage) and message.subtype == "compact_boundary":
              print("Compaction completed")
              print("Pre-compaction tokens:", message.data["compact_metadata"]["pre_tokens"])
              print("Trigger:", message.data["compact_metadata"]["trigger"])
              # Example output:
              # Compaction completed
              # Pre-compaction tokens: 1842
              # Trigger: manual


  asyncio.run(main())
  ```
</CodeGroup>

<Note>
  A `compact_boundary` message only arrives when compaction ran. With nothing to summarize, `/compact` reports the reason instead of raising. The run still ends with a `success` result and no `compact_boundary` message, and the result text carries the reason, for example `Not enough messages to compact.` after a single short exchange. A fresh one-shot `query()` call starts with empty context, so use this pattern in a session with prior turns, for example in [streaming input mode](/docs/en/agent-sdk/streaming-vs-single-mode) or when resuming a session.
</Note>

### Reset context with `/clear`

The `/clear` command resets the conversation to an empty context, so subsequent prompts start with no prior conversation history. The previous conversation remains on disk. You can return to that conversation by passing its session ID to the [`resume` option](/docs/en/agent-sdk/sessions#resume-by-id).

`/clear` is useful in [streaming input mode](/docs/en/agent-sdk/streaming-vs-single-mode), where you send multiple prompts over a single connection. For one-shot `query()` calls, each call already starts with empty context, so sending `/clear` has no practical effect. Start a new `query()` instead.

## Create skills

Create each skill as a directory containing a `SKILL.md` file with YAML frontmatter and Markdown content. The `description` field determines when Claude invokes your skill.

**Example directory structure**:

```text theme={null}
.claude/skills/security-check/
└── SKILL.md
```

### Choose a discovery level

Save skills at either of the two most common [discovery levels](/docs/en/skills#where-skills-live):

* **Project skills**: `.claude/skills/`, available only in the current project
* **Personal skills**: `~/.claude/skills/`, available across all your projects

If you have existing custom command files in `.claude/commands/`, they keep working. A command file at `.claude/commands/deploy.md` creates `/deploy` and works the same way as a skill at `.claude/skills/deploy/SKILL.md` would. If a command file and a skill share a name, see [Where skills live](/docs/en/skills#where-skills-live) for which one runs. The SDK loads `.claude/commands/` and `~/.claude/commands/` files from the same two scopes as skills. See [Extend Claude with skills](/docs/en/skills) for the complete guide to both artifact forms.

### Create and dispatch your first skill

To see the full flow, create `.claude/skills/security-check/SKILL.md`:

```markdown theme={null}
---
name: security-check
description: Run a security vulnerability scan
---

Analyze the codebase for security vulnerabilities including:
- SQL injection risks
- XSS vulnerabilities
- Exposed credentials
- Insecure configurations
```

Once the file exists, the skill is available through the SDK. Claude invokes it when a request matches its description, and you can dispatch it directly:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  for await (const message of query({
    prompt: "/security-check",
    options: { maxTurns: 10 }
  })) {
    if (message.type === "result" && message.subtype === "success") {
      console.log(message.result);
    }
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage


  async def main():
      async for message in query(
          prompt="/security-check", options=ClaudeAgentOptions(max_turns=10)
      ):
          if isinstance(message, ResultMessage) and message.subtype == "success":
              print(message.result)


  asyncio.run(main())
  ```
</CodeGroup>

A successful run ends with a `success` result whose text carries the scan findings. Against a small Express app with seeded issues, the result text begins:

```text theme={null}
**Security scan of `app.js` — 4 findings (most severe first):**

1. **SQL Injection** (line 8) — `req.query.name` is concatenated directly into the SQL string. Trivially exploitable (`' OR '1'='1`, `'; DROP TABLE users;--`). **Fix:** use parameterized queries, e.g. `db.query("SELECT * FROM users WHERE name = ?", [req.query.name], cb)`.
...
```

The skill's name also appears in the init message's `slash_commands` array.

<Note>
  Claude Code includes bundled `code-review` and `verify` skills. If you name a `.claude/commands/` file after one of them, for example `.claude/commands/code-review.md`, the file's command shadows the bundled skill and `slash_commands` lists the name once.
</Note>

## Pre-approve tools for skills

<Note>
  For project and personal skills, Claude Code applies the [`allowed-tools`](/docs/en/skills#pre-approve-tools-for-a-skill) frontmatter field in SDK sessions. You can also pre-approve tools for these skills through the `allowedTools` option (`allowed_tools` in Python) in your query configuration. Skills [synced from claude.ai](/docs/en/skills#how-claude-code-handles-the-frontmatter-of-a-synced-skill) follow their own frontmatter rules.
</Note>

Skills run with the session's tools. The example below pre-approves `Read`, `Grep`, and `Glob` with `allowedTools` (`allowed_tools` in Python), so Claude can inspect files while running the [security-check skill](#create-and-dispatch-your-first-skill) without stopping for approval:

<CodeGroup>
  ```python Python theme={null}
  import asyncio

  from claude_agent_sdk import query, ClaudeAgentOptions

  options = ClaudeAgentOptions(
      setting_sources=["user", "project"],  # Load skills from filesystem
      skills="all",
      allowed_tools=["Read", "Grep", "Glob"],
  )


  async def main():
      async for message in query(prompt="Check this project for security issues", options=options):
          print(message)


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  for await (const message of query({
    prompt: "Check this project for security issues",
    options: {
      settingSources: ["user", "project"], // Load skills from filesystem
      skills: "all",
      allowedTools: ["Read", "Grep", "Glob"]
    }
  })) {
    console.log(message);
  }
  ```
</CodeGroup>

In the stream, the skill invocation appears as a Skill tool use, followed by Read calls on the project files. The run ends with a `success` result whose text carries the findings.

The list pre-approves the named tools rather than restricting the others. For the full permission flow, including permission modes and the `canUseTool` callback, see [Permissions](/docs/en/agent-sdk/permissions).

## Troubleshooting

### Skills not found

**Check settingSources configuration**: the SDK discovers skills through the `user` and `project` setting sources. If you set `settingSources`/`setting_sources` explicitly and omit those sources, the SDK doesn't load skills:

<CodeGroup>
  ```python Python theme={null}
  # Skills not loaded: setting_sources excludes user and project
  options = ClaudeAgentOptions(setting_sources=[], skills="all")

  # Skills loaded: user and project sources included
  options = ClaudeAgentOptions(
      setting_sources=["user", "project"],
      skills="all",
  )
  ```

  ```typescript TypeScript theme={null}
  // Skills not loaded: settingSources excludes user and project
  const optionsWithoutSkills = {
    settingSources: [],
    skills: "all"
  };

  // Skills loaded: user and project sources included
  const optionsWithSkills = {
    settingSources: ["user", "project"],
    skills: "all"
  };
  ```
</CodeGroup>

For which skill directories each source loads, see the [filesystem sources table](/docs/en/agent-sdk/claude-code-features#control-filesystem-settings-with-settingsources). For more details on `settingSources`/`setting_sources`, see the [TypeScript SDK reference](/docs/en/agent-sdk/typescript#settingsource) or [Python SDK reference](/docs/en/agent-sdk/python#settingsource).

**Check working directory**: the SDK loads skills from `.claude/skills/` in the `cwd` option and in every parent directory up to the repository root. Ensure `cwd` points at or below the directory containing `.claude/skills/`, within the same repository:

<CodeGroup>
  ```python Python theme={null}
  # Ensure your cwd points to the directory containing .claude/skills/
  options = ClaudeAgentOptions(
      cwd="/path/to/project",  # .claude/skills/ here or in a parent directory
      setting_sources=["user", "project"],  # Loads skills from these sources
      skills="all",
  )
  ```

  ```typescript TypeScript theme={null}
  // Ensure your cwd points to the directory containing .claude/skills/
  const options = {
    cwd: "/path/to/project", // .claude/skills/ here or in a parent directory
    settingSources: ["user", "project"], // Loads skills from these sources
    skills: "all"
  };
  ```
</CodeGroup>

See [Use skills with the Agent SDK](#use-skills-with-the-agent-sdk) for the complete pattern.

**Verify filesystem location**:

```bash theme={null}
# Check project skills
ls .claude/skills/*/SKILL.md

# Check personal skills
ls ~/.claude/skills/*/SKILL.md
```

### Skill not being used

**Check the `skills` option**: if you passed a `skills` list, confirm the skill's name is included. When Claude tries to invoke an unlisted skill, the Skill tool returns `Skill <name> is not in this session's skills allowlist`. Add the name to your list, or dispatch the skill directly by sending `/<name>` in a prompt, which works without listing.

**Check the description**: ensure it's specific and includes relevant keywords. See [Agent Skills best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#writing-effective-descriptions) for guidance on writing effective descriptions.

### Invalid skill name error

When a name in your `skills` list can't work as an exact skill name, `query()` rejects the list before starting the Claude Code process. Names that trigger the rejection include:

* An empty name
* A name containing parentheses, commas, or control characters
* A name padded with whitespace
* A wildcard form such as a bare `*` or a `:*` suffix

Each SDK surfaces the rejection differently:

<Tabs>
  <Tab title="TypeScript">
    The TypeScript SDK throws an `Error` stating the rule the entry broke. For example, `skills: ["docs:*"]` throws:

    ```text theme={null}
    Invalid skill name "docs:*": wildcard-suffix names are not allowed; list each skill by its exact name.
    ```

    An empty name reports `Skill names must be non-empty strings.`

    Before TypeScript Agent SDK 0.3.221, the SDK didn't run this check.
  </Tab>

  <Tab title="Python">
    The Python SDK raises `ValueError` stating the rule the entry broke. For example, `skills=["docs:*"]` raises:

    ```text theme={null}
    ValueError: Invalid skill name 'docs:*': wildcard-suffix names are not allowed; list each skill by its exact name.
    ```

    An empty name reports `Skill names must be non-empty strings`.

    Before Python Agent SDK 0.2.129, the SDK didn't run this check.
  </Tab>
</Tabs>

### Additional troubleshooting

For general skills troubleshooting, such as YAML syntax errors and debugging, see the [Claude Code skills troubleshooting section](/docs/en/skills#troubleshooting).

## Next steps

The [Claude Code skills guide](/docs/en/skills) covers authoring in depth. Its guidance applies to SDK sessions. Start with these sections:

* [Frontmatter reference](/docs/en/skills#frontmatter-reference): every supported field
* [Pass arguments to skills](/docs/en/skills#pass-arguments-to-skills): `$ARGUMENTS`, `$0`, `$1`, and skill stacking. The [full substitution table](/docs/en/skills#available-string-substitutions) adds named arguments and the `${CLAUDE_*}` variables
* [Inject dynamic context](/docs/en/skills#inject-dynamic-context): `` !`command` `` lines that run before Claude sees the skill content
* [Where skills live](/docs/en/skills#where-skills-live): all discovery levels, plugin namespacing, and what happens when a skill and a command file share a name

## Related resources

* [Commands in Claude Code](/docs/en/commands): the full command surface, including every built-in
* [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview): conceptual overview, benefits, and architecture
* [Agent Skills best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices): authoring guidelines for effective skills
* [Agent Skills cookbook](https://platform.claude.com/cookbook/skills-notebooks-01-skills-introduction): example skills and templates
* [Subagents in the SDK](/docs/en/agent-sdk/subagents): similar filesystem-based agents with programmatic options
* [SDK overview](/docs/en/agent-sdk/overview): general SDK concepts
* [TypeScript SDK reference](/docs/en/agent-sdk/typescript): complete API documentation
* [Python SDK reference](/docs/en/agent-sdk/python): complete API documentation
