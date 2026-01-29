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
import re
import sys
import difflib
from datetime import datetime, timezone
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
    # For CLI usage, look relative to the script's parent directory (project root)
    # since the script lives in /hooks/memory_logger.py
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    return project_root / ".letta" / "memory_logs"


def get_letta_settings() -> dict:
    """Read Letta settings from ~/.letta/settings.json."""
    settings_path = Path.home() / ".letta" / "settings.json"
    if settings_path.exists():
        try:
            return json.loads(settings_path.read_text())
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def get_api_key_from_keychain() -> Optional[str]:
    """Get the Letta API key from macOS keychain via Bun helper."""
    import subprocess

    # Use Bun helper script (uses Bun's existing keychain access)
    hooks_dir = Path(__file__).parent
    helper_script = hooks_dir / "get-api-key.ts"

    if helper_script.exists():
        try:
            result = subprocess.run(
                ["bun", str(helper_script)],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            pass

    return None


def get_api_key() -> Optional[str]:
    """Get the Letta API key from keychain, environment, or settings."""
    # Try macOS keychain first
    api_key = get_api_key_from_keychain()
    if api_key:
        return api_key

    # Fall back to environment variable
    api_key = os.environ.get("LETTA_API_KEY")
    if api_key:
        return api_key

    # Fall back to settings file
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

def fetch_all_memory_blocks(agent_id: str, verbose: bool = False) -> list[dict]:
    """Fetch all memory blocks for an agent from the Letta API."""
    api_key = get_api_key()
    base_url = get_base_url()

    if not api_key:
        if verbose:
            print("  ERROR: No API key available")
        return []

    url = f"{base_url}/v1/agents/{agent_id}/core-memory/blocks"

    if verbose:
        print(f"  URL: {url}")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    try:
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
            if verbose:
                print(f"  Response type: {type(data).__name__}")
            return data if isinstance(data, list) else []
    except urllib.error.HTTPError as e:
        if verbose:
            print(f"  HTTP Error: {e.code} {e.reason}")
            try:
                body = e.read().decode("utf-8")
                print(f"  Response: {body[:200]}")
            except Exception:
                pass
        return []
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as e:
        if verbose:
            print(f"  Error: {type(e).__name__}: {e}")
        return []
    except Exception as e:
        if verbose:
            print(f"  Unexpected error: {type(e).__name__}: {e}")
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
    """Apply or reverse a unified diff (pure Python implementation)."""
    lines = content.splitlines()
    diff_lines = diff_text.splitlines()

    # Parse hunks from diff
    hunks = []
    current_hunk = None

    for line in diff_lines:
        if line.startswith('@@'):
            match = re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', line)
            if match:
                old_start = int(match.group(1))
                new_start = int(match.group(3))
                current_hunk = {
                    'old_start': old_start,
                    'new_start': new_start,
                    'changes': []
                }
                hunks.append(current_hunk)
        elif current_hunk is not None:
            if line.startswith('-'):
                current_hunk['changes'].append(('-', line[1:]))
            elif line.startswith('+'):
                current_hunk['changes'].append(('+', line[1:]))
            elif line.startswith(' '):
                current_hunk['changes'].append((' ', line[1:]))

    if not hunks:
        return content

    # Apply hunks (in reverse order to preserve line numbers)
    result = lines[:]

    for hunk in reversed(hunks):
        if reverse:
            # Reverse: swap + and -
            start = hunk['new_start'] - 1
        else:
            start = hunk['old_start'] - 1

        # Calculate changes
        new_lines = []
        for op, text in hunk['changes']:
            if reverse:
                if op == '-':
                    op = '+'
                elif op == '+':
                    op = '-'

            if op == ' ':
                new_lines.append(text)
            elif op == '+':
                new_lines.append(text)

        # Calculate how many lines to replace
        old_count = sum(1 for op, _ in hunk['changes'] if (op == '-' if not reverse else op == '+') or op == ' ')

        # Replace lines
        result[start:start + old_count] = new_lines

    return '\n'.join(result)


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
        "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if metadata:
        data.update(metadata)

    state_file.write_text(json.dumps(data, indent=2))


def append_diff_log(logs_dir: Path, block_name: str, diff_text: str, metadata: dict = None):
    """Append a diff entry to the log file."""
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_file = logs_dir / f"{block_name}.jsonl"

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
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


def cmd_debug(agent_id: str):
    """Debug command to test API connectivity."""
    print("=== Memory Logger Debug ===\n")

    # Check API key sources
    keychain_key = get_api_key_from_keychain()
    env_key = os.environ.get("LETTA_API_KEY")
    settings = get_letta_settings()
    settings_key = settings.get("env", {}).get("LETTA_API_KEY")

    api_key = keychain_key or env_key or settings_key
    if api_key:
        masked = api_key[:8] + "..." + api_key[-4:] if len(api_key) > 12 else "***"
        source = "keychain" if keychain_key else ("env" if env_key else "settings")
        print(f"API Key: {masked} (from {source})")
    else:
        print("API Key: NOT FOUND")
        print("  - macOS Keychain (service: letta-code, account: letta-api-key)")
        print("  - Environment variable: LETTA_API_KEY")
        print("  - Settings file: ~/.letta/settings.json -> env.LETTA_API_KEY")
        return

    # Check base URL
    base_url = get_base_url()
    print(f"Base URL: {base_url}")

    # Test API call
    print(f"\nFetching memory blocks for agent: {agent_id}")
    blocks = fetch_all_memory_blocks(agent_id, verbose=True)

    if blocks:
        print(f"\nSuccess! Found {len(blocks)} memory block(s):\n")
        for block in blocks:
            label = block.get("label", "unknown")
            value = block.get("value", "")
            preview = value[:50] + "..." if len(value) > 50 else value
            preview = preview.replace("\n", "\\n")
            print(f"  - {label}: {preview}")
    else:
        print("\nNo blocks returned. Possible issues:")
        print("  - Invalid agent_id")
        print("  - API key doesn't have access to this agent")
        print("  - Network/API error")


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

    # Build version list by applying diffs in reverse from current state
    # versions[0] = oldest, versions[-1] = current
    versions = [{"content": current_content, "timestamp": "current", "diff": None}]
    content = current_content

    # Apply diffs in reverse order to reconstruct previous versions
    for entry in reversed(history):
        diff_text = entry.get("diff", "")
        if diff_text:
            content = apply_diff(content, diff_text, reverse=True)
            versions.insert(0, {
                "content": content,
                "timestamp": entry.get("timestamp", "unknown"),
                "diff": diff_text,
            })

    # Interactive navigation with instant key response
    import tty
    import termios

    def getch():
        """Read a single character without waiting for Enter."""
        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            ch = sys.stdin.read(1)
            # Handle escape sequences (arrow keys)
            if ch == '\x1b':
                ch2 = sys.stdin.read(1)
                if ch2 == '[':
                    ch3 = sys.stdin.read(1)
                    if ch3 == 'D':  # Left arrow
                        return 'left'
                    elif ch3 == 'C':  # Right arrow
                        return 'right'
            return ch
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)

    def display_version(idx):
        version = versions[idx]
        label = "current" if version["timestamp"] == "current" else version["timestamp"]
        # Clear screen and move cursor to top
        sys.stdout.write("\033[2J\033[H")
        sys.stdout.write(f"=== {block_name} - Version {idx + 1}/{len(versions)} ({label}) ===\n")
        sys.stdout.write("← → to navigate | d=diff | q=quit\n")
        sys.stdout.write("-" * 50 + "\n")
        sys.stdout.write(version["content"] + "\n")
        sys.stdout.write("-" * 50 + "\n")
        sys.stdout.flush()

    current_idx = len(versions) - 1  # Start at current version
    display_version(current_idx)

    try:
        while True:
            key = getch()

            if key in ('q', '\x03'):  # q or Ctrl+C
                sys.stdout.write("\n")
                sys.stdout.flush()
                break
            elif key in ('left', 'p', 'h'):
                if current_idx > 0:
                    current_idx -= 1
                display_version(current_idx)
            elif key in ('right', 'n', 'l'):
                if current_idx < len(versions) - 1:
                    current_idx += 1
                display_version(current_idx)
            elif key == 'd':
                version = versions[current_idx]
                if version["diff"]:
                    sys.stdout.write("\n" + version["diff"] + "\n")
                    sys.stdout.write("\nPress any key...")
                    sys.stdout.flush()
                    getch()
                display_version(current_idx)
    except (EOFError, KeyboardInterrupt):
        sys.stdout.write("\n")
        sys.stdout.flush()


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

    elif command == "debug":
        if len(args) < 2:
            print("Usage: memory_logger.py debug <agent_id>")
            return
        cmd_debug(args[1])

    else:
        print("Memory Logger - Track memory block changes")
        print()
        print("Commands:")
        print("  list              List all tracked memory blocks")
        print("  show <name>       Show current contents of a block")
        print("  history <name>    Interactive history navigation")
        print("  debug <agent_id>  Test API key and connectivity")
        print()
        print("This script also runs as a PostToolUse hook to track changes.")


if __name__ == "__main__":
    main()
