#!/usr/bin/env python3
"""
Memory Logger Hook - Tracks memory block changes with git-style diffs.

Structure:
  .letta/memory_logs/
    human.json       # Current state from server
    human.jsonl      # Log of diffs (git-style patches)
    persona.json
    persona.jsonl
    ...

Hook: Fetches all memory blocks, compares to local state, logs diffs.
CLI:
  list              - Show all memory blocks
  show <name>       - Show current contents of a block
  history <name>    - Interactive diff navigation
"""

import json
import os
import sys
import difflib
from datetime import datetime
from pathlib import Path
from typing import Optional
import urllib.request
import urllib.error


# =============================================================================
# Configuration
# =============================================================================

def get_logs_dir(working_dir: Optional[str] = None) -> Path:
    """Get the memory logs directory."""
    if working_dir:
        return Path(working_dir) / ".letta" / "memory_logs"
    return Path.cwd() / ".letta" / "memory_logs"


def get_letta_settings() -> dict:
    """Read Letta settings from ~/.letta/settings.json."""
    settings_path = Path.home() / ".letta" / "settings.json"
    if settings_path.exists():
        try:
            return json.loads(settings_path.read_text())
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def get_api_key() -> Optional[str]:
    """Get the Letta API key from settings or environment."""
    api_key = os.environ.get("LETTA_API_KEY")
    if api_key:
        return api_key
    settings = get_letta_settings()
    env_settings = settings.get("env", {})
    return env_settings.get("LETTA_API_KEY")


def get_base_url() -> str:
    """Get the Letta API base URL."""
    base_url = os.environ.get("LETTA_BASE_URL")
    if base_url:
        return base_url.rstrip("/")
    settings = get_letta_settings()
    env_settings = settings.get("env", {})
    return env_settings.get("LETTA_BASE_URL", "https://api.letta.com").rstrip("/")


# =============================================================================
# Letta API
# =============================================================================

def fetch_all_memory_blocks(agent_id: str) -> list[dict]:
    """Fetch all memory blocks for an agent from the Letta API."""
    api_key = get_api_key()
    base_url = get_base_url()

    if not api_key:
        return []

    url = f"{base_url}/v1/agents/{agent_id}/core-memory/blocks"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    try:
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
            return data if isinstance(data, list) else []
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, TimeoutError):
        return []


# =============================================================================
# Diff Operations
# =============================================================================

def create_unified_diff(old_content: str, new_content: str, block_name: str) -> str:
    """Create a unified diff between old and new content."""
    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)

    # Ensure trailing newlines for proper diff
    if old_lines and not old_lines[-1].endswith('\n'):
        old_lines[-1] += '\n'
    if new_lines and not new_lines[-1].endswith('\n'):
        new_lines[-1] += '\n'

    diff = difflib.unified_diff(
        old_lines,
        new_lines,
        fromfile=f"a/{block_name}",
        tofile=f"b/{block_name}",
    )
    return "".join(diff)


def apply_diff(content: str, diff_text: str, reverse: bool = False) -> str:
    """Apply or reverse a unified diff to content."""
    lines = content.splitlines(keepends=True)
    if lines and not lines[-1].endswith('\n'):
        lines[-1] += '\n'

    diff_lines = diff_text.splitlines(keepends=True)

    # Parse the diff
    result_lines = []
    line_idx = 0
    i = 0

    while i < len(diff_lines):
        line = diff_lines[i]

        # Skip header lines
        if line.startswith('---') or line.startswith('+++'):
            i += 1
            continue

        # Parse hunk header: @@ -start,count +start,count @@
        if line.startswith('@@'):
            parts = line.split()
            if len(parts) >= 3:
                old_range = parts[1]  # -start,count
                new_range = parts[2]  # +start,count

                old_start = int(old_range.split(',')[0].lstrip('-'))

                # Copy lines before this hunk
                while line_idx < old_start - 1 and line_idx < len(lines):
                    result_lines.append(lines[line_idx])
                    line_idx += 1
            i += 1
            continue

        # Process diff content
        if line.startswith('-'):
            if reverse:
                # In reverse mode, '-' lines are added back
                result_lines.append(line[1:])
            else:
                # In forward mode, skip '-' lines (they're removed)
                line_idx += 1
            i += 1
        elif line.startswith('+'):
            if reverse:
                # In reverse mode, '+' lines are removed (skip them)
                pass
            else:
                # In forward mode, add '+' lines
                result_lines.append(line[1:])
            i += 1
        elif line.startswith(' '):
            # Context line - keep it
            result_lines.append(line[1:])
            line_idx += 1
            i += 1
        else:
            i += 1

    # Copy remaining lines
    while line_idx < len(lines):
        result_lines.append(lines[line_idx])
        line_idx += 1

    result = "".join(result_lines)
    # Remove trailing newline if original didn't have one
    if result.endswith('\n') and not content.endswith('\n'):
        result = result[:-1]
    return result


# =============================================================================
# State Management
# =============================================================================

def load_current_state(logs_dir: Path, block_name: str) -> Optional[str]:
    """Load the current state of a memory block from local storage."""
    state_file = logs_dir / f"{block_name}.json"
    if state_file.exists():
        try:
            data = json.loads(state_file.read_text())
            return data.get("content", "")
        except (json.JSONDecodeError, IOError):
            pass
    return None


def save_current_state(logs_dir: Path, block_name: str, content: str, metadata: dict = None):
    """Save the current state of a memory block."""
    logs_dir.mkdir(parents=True, exist_ok=True)
    state_file = logs_dir / f"{block_name}.json"

    data = {
        "block_name": block_name,
        "content": content,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }
    if metadata:
        data.update(metadata)

    state_file.write_text(json.dumps(data, indent=2))


def append_diff_log(logs_dir: Path, block_name: str, diff_text: str, metadata: dict = None):
    """Append a diff entry to the log file."""
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_file = logs_dir / f"{block_name}.jsonl"

    entry = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "diff": diff_text,
    }
    if metadata:
        entry.update(metadata)

    with open(log_file, "a") as f:
        f.write(json.dumps(entry) + "\n")


def load_diff_history(logs_dir: Path, block_name: str) -> list[dict]:
    """Load all diff entries for a memory block."""
    log_file = logs_dir / f"{block_name}.jsonl"
    history = []

    if log_file.exists():
        try:
            for line in log_file.read_text().splitlines():
                if line.strip():
                    history.append(json.loads(line))
        except (json.JSONDecodeError, IOError):
            pass

    return history


# =============================================================================
# Hook Handler
# =============================================================================

def handle_hook(data: dict) -> None:
    """Handle a PostToolUse hook event for memory operations."""
    agent_id = data.get("agent_id", "")
    working_dir = data.get("working_directory")
    tool_result = data.get("tool_result", {})

    # Only process successful operations
    if tool_result.get("status") != "success":
        return

    if not agent_id:
        return

    logs_dir = get_logs_dir(working_dir)

    # Fetch all memory blocks from the server
    blocks = fetch_all_memory_blocks(agent_id)

    if not blocks:
        return

    # Compare each block with local state and log diffs
    for block in blocks:
        block_name = block.get("label", "")
        server_content = block.get("value", "")

        if not block_name:
            continue

        # Load local state
        local_content = load_current_state(logs_dir, block_name)

        # If no local state, initialize it
        if local_content is None:
            save_current_state(logs_dir, block_name, server_content, {
                "description": block.get("description", ""),
            })
            continue

        # If content changed, create diff and log it
        if local_content != server_content:
            diff_text = create_unified_diff(local_content, server_content, block_name)

            if diff_text:  # Only log if there's an actual diff
                append_diff_log(logs_dir, block_name, diff_text, {
                    "agent_id": agent_id,
                })

            # Update local state
            save_current_state(logs_dir, block_name, server_content, {
                "description": block.get("description", ""),
            })


# =============================================================================
# CLI Commands
# =============================================================================

def cmd_list(logs_dir: Path):
    """List all tracked memory blocks."""
    if not logs_dir.exists():
        print("No memory blocks tracked yet.")
        return

    blocks = []
    for f in logs_dir.glob("*.json"):
        block_name = f.stem
        try:
            data = json.loads(f.read_text())
            content = data.get("content", "")
            updated_at = data.get("updated_at", "unknown")

            # Count history entries
            log_file = logs_dir / f"{block_name}.jsonl"
            history_count = 0
            if log_file.exists():
                history_count = len(log_file.read_text().splitlines())

            blocks.append({
                "name": block_name,
                "size": len(content),
                "history": history_count,
                "updated": updated_at,
            })
        except (json.JSONDecodeError, IOError):
            pass

    if not blocks:
        print("No memory blocks tracked yet.")
        return

    print(f"{'Block Name':<20} {'Size':>8} {'History':>8} {'Updated':<25}")
    print("-" * 65)
    for b in sorted(blocks, key=lambda x: x["name"]):
        print(f"{b['name']:<20} {b['size']:>8} {b['history']:>8} {b['updated']:<25}")


def cmd_show(logs_dir: Path, block_name: str):
    """Show the current contents of a memory block."""
    state_file = logs_dir / f"{block_name}.json"

    if not state_file.exists():
        print(f"Memory block '{block_name}' not found.")
        print(f"Available blocks: {', '.join(f.stem for f in logs_dir.glob('*.json'))}")
        return

    try:
        data = json.loads(state_file.read_text())
        content = data.get("content", "")
        print(content)
    except (json.JSONDecodeError, IOError) as e:
        print(f"Error reading block: {e}")


def cmd_history(logs_dir: Path, block_name: str):
    """Interactive history navigation for a memory block."""
    state_file = logs_dir / f"{block_name}.json"

    if not state_file.exists():
        print(f"Memory block '{block_name}' not found.")
        return

    # Load current state and history
    try:
        data = json.loads(state_file.read_text())
        current_content = data.get("content", "")
    except (json.JSONDecodeError, IOError) as e:
        print(f"Error reading block: {e}")
        return

    history = load_diff_history(logs_dir, block_name)

    if not history:
        print(f"No history for '{block_name}'. Current content:")
        print("-" * 40)
        print(current_content)
        return

    # Build version list by applying diffs in reverse
    versions = [{"content": current_content, "timestamp": "current", "diff": None}]
    content = current_content

    for entry in reversed(history):
        diff_text = entry.get("diff", "")
        if diff_text:
            content = apply_diff(content, diff_text, reverse=True)
            versions.insert(0, {
                "content": content,
                "timestamp": entry.get("timestamp", "unknown"),
                "diff": diff_text,
            })

    # Interactive navigation
    try:
        import curses
        curses_available = True
    except ImportError:
        curses_available = False

    if curses_available and sys.stdout.isatty():
        run_interactive_history(versions, block_name)
    else:
        # Fallback: print all versions
        print(f"History for '{block_name}' ({len(versions)} versions):")
        print("=" * 60)
        for i, v in enumerate(versions):
            label = "current" if v["timestamp"] == "current" else v["timestamp"]
            print(f"\n[Version {i + 1}] {label}")
            print("-" * 40)
            print(v["content"])
            print()


def run_interactive_history(versions: list[dict], block_name: str):
    """Run interactive curses-based history viewer."""
    import curses

    def main(stdscr):
        curses.curs_set(0)  # Hide cursor
        stdscr.clear()

        current_idx = len(versions) - 1  # Start at current version

        while True:
            stdscr.clear()
            height, width = stdscr.getmaxyx()

            version = versions[current_idx]
            label = "current" if version["timestamp"] == "current" else version["timestamp"]

            # Header
            header = f" {block_name} - Version {current_idx + 1}/{len(versions)} ({label}) "
            stdscr.addstr(0, 0, header.center(width, "=")[:width-1])
            stdscr.addstr(1, 0, " Use ← → arrows to navigate, 'd' for diff, 'q' to quit "[:width-1])
            stdscr.addstr(2, 0, "-" * (width - 1))

            # Content
            content_lines = version["content"].splitlines()
            max_lines = height - 5

            for i, line in enumerate(content_lines[:max_lines]):
                if i + 3 < height - 1:
                    stdscr.addstr(i + 3, 0, line[:width-1])

            if len(content_lines) > max_lines:
                stdscr.addstr(height - 2, 0, f"... ({len(content_lines) - max_lines} more lines)"[:width-1])

            stdscr.refresh()

            # Handle input
            key = stdscr.getch()

            if key == ord('q') or key == 27:  # q or ESC
                break
            elif key == curses.KEY_LEFT or key == ord('h'):
                if current_idx > 0:
                    current_idx -= 1
            elif key == curses.KEY_RIGHT or key == ord('l'):
                if current_idx < len(versions) - 1:
                    current_idx += 1
            elif key == ord('d'):
                # Show diff
                if version["diff"]:
                    stdscr.clear()
                    stdscr.addstr(0, 0, f" Diff for version {current_idx + 1} ".center(width, "=")[:width-1])
                    diff_lines = version["diff"].splitlines()
                    for i, line in enumerate(diff_lines[:height-3]):
                        if i + 2 < height - 1:
                            # Color diff lines
                            if line.startswith('+') and not line.startswith('+++'):
                                stdscr.addstr(i + 2, 0, line[:width-1], curses.A_BOLD)
                            elif line.startswith('-') and not line.startswith('---'):
                                stdscr.addstr(i + 2, 0, line[:width-1], curses.A_DIM)
                            else:
                                stdscr.addstr(i + 2, 0, line[:width-1])
                    stdscr.addstr(height - 1, 0, "Press any key to continue..."[:width-1])
                    stdscr.refresh()
                    stdscr.getch()

    curses.wrapper(main)


# =============================================================================
# Main
# =============================================================================

def main():
    """Main entry point."""
    args = sys.argv[1:]

    # If no args, we're being called as a hook - read from stdin
    if not args:
        try:
            data = json.load(sys.stdin)
            handle_hook(data)
        except (json.JSONDecodeError, IOError):
            pass
        return

    # CLI commands
    logs_dir = get_logs_dir()
    command = args[0].lower()

    if command == "list":
        cmd_list(logs_dir)

    elif command == "show":
        if len(args) < 2:
            print("Usage: memory_logger.py show <block_name>")
            return
        cmd_show(logs_dir, args[1])

    elif command == "history":
        if len(args) < 2:
            print("Usage: memory_logger.py history <block_name>")
            return
        cmd_history(logs_dir, args[1])

    else:
        print("Memory Logger - Track memory block changes")
        print()
        print("Commands:")
        print("  list              List all tracked memory blocks")
        print("  show <name>       Show current contents of a block")
        print("  history <name>    Interactive history navigation")
        print()
        print("This script also runs as a PostToolUse hook to track changes.")


if __name__ == "__main__":
    main()
