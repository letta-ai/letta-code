# Letta Code (Research Preview)

A self-improving, stateful coding agent that can learn from experience and improve with use.

## What is Letta Code?

Letta Code is a command-line harness around the stateful Letta [Agents API](https://docs.letta.com/api-reference/overview). You can use Letta Code to create and connect with any Letta agent (even non-coding agents!) - Letta Code simply gives your agents the ability to interact with your local dev environment, directly in your terminal.

> [!IMPORTANT]
> Letta Code is a **research preview** in active development, and may have bugs or unexpected issues. To learn more about the roadmap and chat with the dev team, visit our Discord at [discord.gg/letta](https:/discord.gg/letta). Contributions welcome, join the fun.

## Quickstart

> Get a Letta API key at: [https://app.letta.com](https://app.letta.com/)

Install the package via [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm):
```bash
npm install -g @letta-ai/letta-code
```

Make sure you have your Letta API key set in your environment:
```bash
export LETTA_API_KEY=...
```

Then run `letta` to start Letta Code (see various command-line options below):
```
letta
```

## Quickstart (from source)

First, install Bun if you don't have it yet: [https://bun.com/docs/installation](https://bun.com/docs/installation)

### Run directly from source (dev workflow)
```bash
# install deps
bun install

# run the CLI from TypeScript sources (pick up changes immediately)
bun run dev:ui
bun run dev:ui -- -p "Hello world"  # example with args
```

### Build + link the standalone binary
```bash
# build bin/letta (includes prompts + schemas)
bun run build

# expose the binary globally (adjust to your preference)
bun link --global   # or: bun add --global .

# now you can run the compiled CLI
letta
```
> Whenever you change source files, rerun `bun run build` before using the linked `letta` binary so it picks up your edits.

## Usage

### Interactive Mode
```bash
letta                    # Start new session
letta --continue         # Resume last session
letta --agent <id>       # Open specific agent
```

### Headless Mode
```bash
letta -p "your prompt"                           # Run non-interactive
letta -p "commit changes" --continue             # Continue previous session
letta -p "run tests" --allowedTools "Bash"       # Control tool permissions
letta -p "run tests" --disallowedTools "Bash"    # Control tool permissions

# Pipe input from stdin
echo "Explain this code" | letta -p
cat file.txt | letta -p
gh pr diff 123 | letta -p --yolo                 # Review PR changes
```

You can also use the `--tools` flag to control the underlying *attachment* of tools (not just the permissions).
Compared to disallowing the tool, this will additionally remove the tool schema from the agent's context window.
```bash
letta -p "run tests" --tools "Bash,Read"         # Only load specific tools
letta -p "analyze code" --tools ""               # No tools (analysis only)
```

### Permissions

**Tool selection** (controls which tools are loaded):
```bash
--tools "Bash,Read,Write"                        # Only load these tools
--tools ""                                       # No tools (conversation only)
```

**Permission overrides** (controls tool access, applies to loaded tools):
```bash
--allowedTools "Bash,Read,Write"                 # Allow specific tools
--allowedTools "Bash(npm run test:*)"            # Allow specific commands
--disallowedTools "Bash(curl:*)"                 # Block specific patterns
--permission-mode acceptEdits                    # Auto-allow Write/Edit tools
--permission-mode plan                           # Read-only mode
--permission-mode bypassPermissions              # Allow all tools (use carefully!)
--yolo                                           # Alias for --permission-mode bypassPermissions
```

Permission modes:
- `default` - Standard behavior, prompts for approval
- `acceptEdits` - Auto-allows Write/Edit/NotebookEdit
- `plan` - Read-only, allows analysis but blocks modifications
- `bypassPermissions` - Auto-allows all tools (for trusted environments)

Permissions are also configured in `.letta/settings.json`:
```json
{
  "permissions": {
    "allow": ["Bash(npm run lint)", "Read(src/**)"],
    "deny": ["Bash(rm -rf:*)", "Read(.env)"]
  }
}
```

---

Made with 💜 in San Francisco
