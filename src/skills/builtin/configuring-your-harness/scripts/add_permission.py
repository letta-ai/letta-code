#!/usr/bin/env python3
"""
Add a permission rule to Letta Code settings.

Usage:
    python3 add_permission.py --rule "Bash(npm run:*)" --type allow --scope user
    python3 add_permission.py --rule "Read(src/**)" --type allow --scope project
"""

import argparse
import json
import os
import sys
from pathlib import Path


def get_settings_path(scope: str, working_directory: str) -> Path:
    """Get the settings file path for a given scope."""
    if scope == "user":
        return Path.home() / ".letta" / "settings.json"
    elif scope == "project":
        return Path(working_directory) / ".letta" / "settings.json"
    elif scope == "local":
        return Path(working_directory) / ".letta" / "settings.local.json"
    else:
        raise ValueError(f"Unknown scope: {scope}")


def load_settings(path: Path) -> dict:
    """Load settings from a JSON file, or return empty dict if not found."""
    if path.exists():
        try:
            with open(path) as f:
                return json.load(f)
        except json.JSONDecodeError:
            print(f"Warning: Could not parse {path}, starting fresh", file=sys.stderr)
            return {}
    return {}


def save_settings(path: Path, settings: dict) -> None:
    """Save settings to a JSON file, creating parent directories if needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(settings, f, indent=2)
    print(f"Saved to {path}")


def add_rule(settings: dict, rule: str, rule_type: str) -> bool:
    """
    Add a permission rule to settings.

    Returns True if the rule was added, False if it already exists.
    """
    if "permissions" not in settings:
        settings["permissions"] = {}

    if rule_type not in settings["permissions"]:
        settings["permissions"][rule_type] = []

    rules = settings["permissions"][rule_type]

    if rule in rules:
        return False

    rules.append(rule)
    return True


def ensure_local_gitignored(working_directory: str) -> None:
    """Ensure .letta/settings.local.json is in .gitignore."""
    gitignore_path = Path(working_directory) / ".gitignore"
    pattern = ".letta/settings.local.json"

    try:
        content = ""
        if gitignore_path.exists():
            content = gitignore_path.read_text()

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
        description="Add a permission rule to Letta Code settings"
    )
    parser.add_argument(
        "--rule",
        required=True,
        help='Permission rule pattern, e.g., "Bash(npm run:*)" or "Read(src/**)"',
    )
    parser.add_argument(
        "--type",
        required=True,
        choices=["allow", "deny", "ask"],
        help="Type of permission rule",
    )
    parser.add_argument(
        "--scope",
        required=True,
        choices=["user", "project", "local"],
        help="Where to save the rule",
    )
    parser.add_argument(
        "--cwd",
        default=os.getcwd(),
        help="Working directory for project/local scope (default: current directory)",
    )

    args = parser.parse_args()

    settings_path = get_settings_path(args.scope, args.cwd)
    settings = load_settings(settings_path)

    if add_rule(settings, args.rule, args.type):
        save_settings(settings_path, settings)
        print(f"Added {args.type} rule: {args.rule}")

        # Ensure local settings are gitignored
        if args.scope == "local":
            ensure_local_gitignored(args.cwd)
    else:
        print(f"Rule already exists: {args.rule}")
        sys.exit(0)


if __name__ == "__main__":
    main()
