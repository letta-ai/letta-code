#!/usr/bin/env python3
"""
Add a hook to Letta Code settings.

Examples:
    # Command hook for Bash tool calls
    python3 add_hook.py --event PreToolUse --matcher Bash \
        --type command --command 'echo "$TOOL_INPUT" >> audit.log' \
        --scope user

    # Prompt hook for pre-edit safety check
    python3 add_hook.py --event PreToolUse --matcher "Edit|Write" \
        --type prompt --prompt 'Is this safe? Input: $ARGUMENTS' \
        --model gpt-5.2 --scope project

    # Simple event hook (no matcher needed)
    python3 add_hook.py --event Stop \
        --type command --command 'say done' \
        --scope user
"""

import argparse
import json
import os
import sys
from pathlib import Path

TOOL_EVENTS = {"PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"}
SIMPLE_EVENTS = {
    "UserPromptSubmit",
    "Notification",
    "Stop",
    "SubagentStop",
    "PreCompact",
    "SessionStart",
    "SessionEnd",
}
ALL_EVENTS = TOOL_EVENTS | SIMPLE_EVENTS

PROMPT_SUPPORTED = {
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "UserPromptSubmit",
    "Stop",
    "SubagentStop",
}


def get_settings_path(scope: str, working_directory: str) -> Path:
    if scope == "user":
        return Path.home() / ".letta" / "settings.json"
    elif scope == "project":
        return Path(working_directory) / ".letta" / "settings.json"
    elif scope == "local":
        return Path(working_directory) / ".letta" / "settings.local.json"
    else:
        raise ValueError(f"Unknown scope: {scope}")


def load_settings(path: Path) -> dict:
    if path.exists():
        try:
            with open(path) as f:
                return json.load(f)
        except json.JSONDecodeError:
            print(f"Warning: Could not parse {path}, starting fresh", file=sys.stderr)
            return {}
    return {}


def save_settings(path: Path, settings: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(settings, f, indent=2)
    print(f"Saved to {path}")


def build_hook_config(args) -> dict:
    """Build the individual hook config from args."""
    hook: dict = {"type": args.type}

    if args.type == "command":
        if not args.command:
            raise ValueError("--command is required for type=command")
        hook["command"] = args.command
    elif args.type == "prompt":
        if not args.prompt:
            raise ValueError("--prompt is required for type=prompt")
        if args.event not in PROMPT_SUPPORTED:
            raise ValueError(
                f"Event {args.event!r} does not support prompt hooks. "
                f"Supported: {sorted(PROMPT_SUPPORTED)}"
            )
        hook["prompt"] = args.prompt
        if args.model:
            hook["model"] = args.model

    if args.timeout is not None:
        hook["timeout"] = args.timeout

    return hook


def add_hook(settings: dict, args) -> None:
    """Add a hook entry to the settings dict."""
    if "hooks" not in settings:
        settings["hooks"] = {}

    hooks_config = settings["hooks"]
    event = args.event

    if event not in hooks_config:
        hooks_config[event] = []

    hook = build_hook_config(args)

    if event in TOOL_EVENTS:
        # Tool events: need a matcher
        matcher = args.matcher or "*"
        # Find existing matcher group or create new one
        entry = next(
            (e for e in hooks_config[event] if e.get("matcher") == matcher), None
        )
        if entry is None:
            entry = {"matcher": matcher, "hooks": []}
            hooks_config[event].append(entry)
        entry["hooks"].append(hook)
    else:
        # Simple events: no matcher, just hooks
        if hooks_config[event]:
            # Append to existing group
            hooks_config[event][0].setdefault("hooks", []).append(hook)
        else:
            hooks_config[event].append({"hooks": [hook]})


def ensure_local_gitignored(working_directory: str) -> None:
    gitignore_path = Path(working_directory) / ".gitignore"
    pattern = ".letta/settings.local.json"
    try:
        content = gitignore_path.read_text() if gitignore_path.exists() else ""
        if pattern not in content:
            with open(gitignore_path, "a") as f:
                if content and not content.endswith("\n"):
                    f.write("\n")
                f.write(f"{pattern}\n")
            print(f"Added {pattern} to .gitignore")
    except Exception as e:
        print(f"Warning: Could not update .gitignore: {e}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(
        description="Add a hook to Letta Code settings",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--event",
        required=True,
        choices=sorted(ALL_EVENTS),
        help="Hook event name",
    )
    parser.add_argument(
        "--matcher",
        help="Tool matcher pattern (for tool events). Examples: 'Bash', 'Edit|Write', '*'",
    )
    parser.add_argument(
        "--type",
        required=True,
        choices=["command", "prompt"],
        help="Hook type",
    )
    parser.add_argument("--command", help="Shell command (for type=command)")
    parser.add_argument(
        "--prompt",
        help="LLM prompt text (for type=prompt). Use $ARGUMENTS for hook input JSON.",
    )
    parser.add_argument("--model", help="LLM model (for type=prompt)")
    parser.add_argument(
        "--timeout", type=int, help="Timeout in milliseconds (default: 60000/30000)"
    )
    parser.add_argument(
        "--scope",
        required=True,
        choices=["user", "project", "local"],
        help="Where to save the hook",
    )
    parser.add_argument(
        "--cwd",
        default=os.getcwd(),
        help="Working directory for project/local scope (default: cwd)",
    )

    args = parser.parse_args()

    # Validation
    if args.event in TOOL_EVENTS and not args.matcher:
        print(
            f"Warning: {args.event} is a tool event; using matcher='*' (match all tools)",
            file=sys.stderr,
        )

    settings_path = get_settings_path(args.scope, args.cwd)
    settings = load_settings(settings_path)

    try:
        add_hook(settings, args)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    save_settings(settings_path, settings)
    print(f"Added {args.type} hook on {args.event}")

    if args.scope == "local":
        ensure_local_gitignored(args.cwd)


if __name__ == "__main__":
    main()
