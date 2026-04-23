---
name: "managing-permissions"
description: "Add, view, or modify permission rules that control which tool calls require approval. Use when you want to auto-approve certain commands or file operations."
---

# Managing Permissions

Letta Code uses a permission system to control which tool executions require user approval. You can add rules to auto-approve (allow), auto-deny (deny), or always ask for certain tool patterns.

## Permission Rule Format

Rules follow the pattern: `ToolName(argument-pattern)`

### Bash Commands

Bash commands use **prefix matching** with the `:*` suffix:

| Rule | Matches |
|------|---------|
| `Bash(npm install:*)` | `npm install`, `npm install lodash`, etc. |
| `Bash(git status)` | Exact match: only `git status` |
| `Bash(curl:*)` | Any curl command |
| `Bash(:*)` | All bash commands (use carefully) |

**Important**: The `:*` suffix means "this prefix plus any arguments". Without it, the rule only matches the exact command.

### File Operations

File tools use **glob patterns**:

| Rule | Matches |
|------|---------|
| `Read(src/**)` | Read any file under `src/` recursively |
| `Write(*.md)` | Write any markdown file in current directory |
| `Edit(**/*.ts)` | Edit TypeScript files anywhere |
| `Read(~/.env)` | Read the user's `.env` file |
| `Read(/etc/hosts)` | Read absolute path (use `//` prefix in rules: `Read(//etc/hosts)`) |

### Special Patterns

| Rule | Matches |
|------|---------|
| `*` | All tools (dangerous, use only in trusted environments) |
| `Read` | All Read calls without argument checking |
| `Bash` | All Bash calls (equivalent to `Bash(:*)`) |

## Settings Files and Scopes

Permissions are stored in JSON settings files. Rules are merged with the following precedence (highest to lowest):

1. **Local** (`.letta/settings.local.json`) - Gitignored, for personal overrides
2. **Project** (`.letta/settings.json`) - Shared with team
3. **User** (`~/.letta/settings.json`) - Global user preferences
4. **Session** - In-memory only, cleared on exit

## Adding Rules Manually

Edit the appropriate settings file and add a `permissions` object:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run:*)",
      "Bash(git:*)",
      "Read(src/**)",
      "Read(tests/**)"
    ],
    "deny": [
      "Bash(rm -rf:*)"
    ],
    "ask": []
  }
}
```

### User-level (applies everywhere)

Edit `~/.letta/settings.json`:

```bash
# View current settings
cat ~/.letta/settings.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('permissions', {}), indent=2))"

# Add a rule
python3 <path-to-skill>/scripts/add_permission.py --rule "Bash(curl:*)" --type allow --scope user
```

### Project-level

Edit `.letta/settings.json` in your project:

```bash
python3 <path-to-skill>/scripts/add_permission.py --rule "Bash(npm run:*)" --type allow --scope project
```

### Local overrides (gitignored)

Edit `.letta/settings.local.json`:

```bash
python3 <path-to-skill>/scripts/add_permission.py --rule "Bash(deploy:*)" --type allow --scope local
```

## Using the Helper Scripts

### Add a permission rule

```bash
python3 <path-to-skill>/scripts/add_permission.py \
  --rule "Bash(npm run:*)" \
  --type allow \
  --scope user
```

Options:
- `--rule`: The permission rule pattern
- `--type`: One of `allow`, `deny`, or `ask`
- `--scope`: One of `user`, `project`, or `local`

### List current permissions

```bash
python3 <path-to-skill>/scripts/list_permissions.py
```

Shows merged permissions from all scopes with their source.

## Common Permission Patterns

### Development workflows

```json
{
  "permissions": {
    "allow": [
      "Bash(npm:*)",
      "Bash(yarn:*)",
      "Bash(pnpm:*)",
      "Bash(bun:*)",
      "Bash(cargo:*)",
      "Bash(go:*)",
      "Bash(python:*)",
      "Bash(uv:*)",
      "Bash(git:*)",
      "Bash(gh:*)",
      "Read(src/**)",
      "Read(tests/**)",
      "Read(docs/**)",
      "Edit(src/**)",
      "Edit(tests/**)"
    ]
  }
}
```

### CI/CD and deployment

```json
{
  "permissions": {
    "allow": [
      "Bash(docker:*)",
      "Bash(kubectl:*)",
      "Bash(terraform:*)"
    ],
    "deny": [
      "Bash(rm -rf /)",
      "Bash(chmod 777:*)"
    ]
  }
}
```

### Database access

```json
{
  "permissions": {
    "allow": [
      "Bash(psql:*)",
      "Bash(mysql:*)",
      "Bash(mongosh:*)"
    ]
  }
}
```

### API calls with credentials

```json
{
  "permissions": {
    "allow": [
      "Bash(curl -s --user \"$CLICKHOUSE_USER:*)"
    ]
  }
}
```

## Troubleshooting

### Rule not matching

1. Check the pattern syntax - Bash needs `:*` for prefix matching
2. Verify the scope - local rules override project rules
3. Restart Letta Code - settings are loaded at startup

### Finding the right pattern

When a tool execution is prompted for approval, the dialog shows the exact tool call. Use that to craft your rule:

- If prompted for `Bash(npm run build)`, use rule `Bash(npm run:*)`
- If prompted for `Read(/Users/me/project/src/index.ts)`, use rule `Read(src/**)`

### Checking effective permissions

Run the list script to see all active rules:

```bash
python3 <path-to-skill>/scripts/list_permissions.py
```
