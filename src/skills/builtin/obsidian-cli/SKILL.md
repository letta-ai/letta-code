---
name: obsidian-cli
description: Work with Obsidian vaults using the official Obsidian CLI. Read, create, append, search, and manage notes, daily notes, properties, tags, tasks, sync, and more from the terminal. Use when the user mentions Obsidian, notes, vault, daily notes, or when working with markdown knowledge bases. Requires Obsidian desktop app running with CLI enabled in Settings > General.
---

# Obsidian CLI

Official Obsidian CLI for terminal vault operations. Requires Obsidian running (headless via xvfb works) with CLI enabled and insider/early access mode.

All parameters use `key=value` syntax: `obsidian read path="folder/note.md"`. On headless Linux, prefix with `DISPLAY=:5` (or whatever your xvfb display is).

## Core Commands

### Daily Notes

```bash
obsidian daily                           # Open today's daily note
obsidian daily:read                      # Print today's note content
obsidian daily:append content="text"     # Append to today's note
obsidian daily:prepend content="text"    # Prepend to today's note
```

### Reading and Writing Files

```bash
obsidian read path="folder/note.md"                          # Read note
obsidian create path="folder/note" content="# Title"         # Create note (path without .md)
obsidian create path="folder/note" template="templatename"    # Create from template
obsidian append path="folder/note.md" content="text"          # Append to note
obsidian prepend path="folder/note.md" content="text"         # Prepend to note
obsidian move path="old/note.md" name="new-name"              # Move/rename
obsidian delete path="folder/note.md"                         # Delete (to trash)
obsidian delete path="folder/note.md" permanent               # Permanent delete
```

### File Discovery

```bash
obsidian files                      # List all files
obsidian files ext=md               # Only markdown files
obsidian files folder="subfolder"   # Files in specific folder
obsidian files total                # Just the count
obsidian folders                    # List all folders
obsidian file path="folder/note.md" # File info (size, dates)
```

### Search

```bash
obsidian search query="search text"                    # Search vault
obsidian search query="text" path="folder" limit=10    # Scoped search
obsidian search query="text" format=json               # JSON output
obsidian search query="text" matches                   # Show match context
obsidian search query="text" case                      # Case-sensitive
```

### Links and Graph

```bash
obsidian backlinks path="note.md"      # Backlinks to a note
obsidian backlinks path="note.md" counts  # With link counts
obsidian links path="note.md"          # Outgoing links (requires plugin)
obsidian unresolved                    # Unresolved [[links]]
obsidian orphans                       # Notes with no links in or out
obsidian deadends                      # Notes with no outgoing links
```

### Properties (Frontmatter)

```bash
obsidian properties path="note.md"                          # All properties
obsidian property:read path="note.md" name="status"         # Read one property
obsidian property:set path="note.md" name="status" value="draft"  # Set property
obsidian property:remove path="note.md" name="status"       # Remove property
obsidian aliases path="note.md"                             # List aliases
```

### Tags

```bash
obsidian tags                          # All tags
obsidian tags counts sort=count        # Tags sorted by frequency
obsidian tags path="note.md"           # Tags in specific file
obsidian tag name="tagname"            # Notes with specific tag
```

### Tasks

```bash
obsidian tasks                              # All incomplete tasks
obsidian tasks all                          # All tasks (done + todo)
obsidian tasks done                         # Only completed tasks
obsidian tasks path="note.md"               # Tasks in specific file
obsidian tasks daily                        # Tasks in today's daily note
obsidian task path="note.md" line=5 toggle  # Toggle task status
```

### Sync

```bash
obsidian sync                                  # Show sync status
obsidian sync on                               # Resume sync
obsidian sync off                              # Pause sync
obsidian sync:status                           # Detailed status
obsidian sync:history path="note.md"           # Version history
obsidian sync:read path="note.md" version=3    # Read specific version
obsidian sync:restore path="note.md" version=3 # Restore version
obsidian sync:deleted                          # Deleted files in sync
```

### Templates

```bash
obsidian templates                          # List templates
obsidian template:read name="weekly-review" # Read template content
obsidian template:read name="weekly-review" resolve title="My Note"  # Render with variables
obsidian template:insert name="weekly-review"  # Insert into active file
```

### Other Useful Commands

```bash
obsidian vault                         # Vault info (name, path, file count, size)
obsidian vaults                        # List all known vaults
obsidian outline path="note.md"        # Heading structure
obsidian wordcount path="note.md"      # Word/character count
obsidian recents                       # Recently opened files
obsidian version                       # Obsidian version
obsidian reload                        # Reload vault
```

### Plugins

```bash
obsidian plugins                    # List all plugins
obsidian plugins:enabled            # List enabled plugins
obsidian plugin:enable id="canvas"  # Enable plugin
obsidian plugin:disable id="canvas" # Disable plugin
obsidian plugin:install id="name"   # Install from community
obsidian plugin:reload id="name"    # Reload plugin
```

### Developer Commands

```bash
obsidian dev:screenshot path="screenshot.png"   # Screenshot
obsidian eval code="app.vault.getFiles().length" # Run JS in Obsidian
obsidian dev:console limit=20                    # Recent console output
obsidian dev:errors                              # Recent errors
```

## Common Agent Patterns

### Append to Daily Note with Linking

```bash
obsidian daily:append content="
## Reports
- [[reports/2026-02-10-morning|Morning Report]]
"
```

### Create Note and Cross-Link

```bash
obsidian create path="reports/morning-report" content="# Morning Report"
obsidian daily:append content="- [[reports/morning-report|Morning Report]]"
```

### Set Properties Programmatically

```bash
obsidian property:set path="note.md" name="status" value="draft"
obsidian property:set path="note.md" name="date" value="2026-02-10"
```

## Setup

### Requirements
- Obsidian desktop app installed and running (v1.12.0+ with insider/early access)
- CLI enabled: Settings > General > CLI toggle
- `insider` and `cli` set to `true` in global config (`~/.config/obsidian/obsidian.json` on Linux, `~/Library/Application Support/obsidian/obsidian.json` on macOS)

### Headless Linux
Use deb package (not snap - snap confinement breaks CLI IPC). Run under xvfb. See references/headless-setup.md for config transfer details.

### Multi-Vault
Use `vault="Vault Name"` parameter: `obsidian vault="Notes" daily:read`

## Tips

1. **Parameter syntax**: Always `key=value`, not positional. Quote values with spaces: `content="hello world"`
2. **Pipe-friendly**: Plain text output, works with grep/awk/jq
3. **JSON output**: `format=json` on search and other commands
4. **Headless prefix**: `DISPLAY=:5 obsidian <command>` on headless Linux
5. **Paths are vault-relative**, not filesystem-relative
6. **Stderr noise**: GPU errors on headless are harmless, filter with `2>/dev/null` or grep
