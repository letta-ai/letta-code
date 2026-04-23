#!/usr/bin/env python3
"""
List all permission rules from Letta Code settings.

Shows rules from all scopes (user, project, local) with their source.

Usage:
    python3 list_permissions.py
    python3 list_permissions.py --cwd /path/to/project
"""

import argparse
import json
import os
from pathlib import Path


def get_settings_paths(working_directory: str) -> list[tuple[str, Path]]:
    """Get all settings file paths in precedence order (lowest to highest)."""
    return [
        ("user", Path.home() / ".letta" / "settings.json"),
        ("project", Path(working_directory) / ".letta" / "settings.json"),
        ("local", Path(working_directory) / ".letta" / "settings.local.json"),
    ]


def load_permissions(path: Path) -> dict[str, list[str]]:
    """Load permissions from a settings file."""
    if not path.exists():
        return {}

    try:
        with open(path) as f:
            settings = json.load(f)
            return settings.get("permissions", {})
    except (json.JSONDecodeError, IOError):
        return {}


def main():
    parser = argparse.ArgumentParser(
        description="List all permission rules from Letta Code settings"
    )
    parser.add_argument(
        "--cwd",
        default=os.getcwd(),
        help="Working directory for project/local scope (default: current directory)",
    )
    parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    # Collect all rules with their sources
    all_rules: dict[str, list[tuple[str, str]]] = {
        "allow": [],
        "deny": [],
        "ask": [],
    }

    for scope, path in get_settings_paths(args.cwd):
        permissions = load_permissions(path)
        for rule_type in ["allow", "deny", "ask"]:
            for rule in permissions.get(rule_type, []):
                all_rules[rule_type].append((rule, scope))

    if args.json:
        # JSON output
        output = {
            rule_type: [{"rule": r, "scope": s} for r, s in rules]
            for rule_type, rules in all_rules.items()
        }
        print(json.dumps(output, indent=2))
    else:
        # Human-readable output
        print("Letta Code Permission Rules")
        print("=" * 40)
        print(f"Working directory: {args.cwd}")
        print()

        for rule_type in ["allow", "deny", "ask"]:
            rules = all_rules[rule_type]
            if rules:
                print(f"{rule_type.upper()} ({len(rules)} rules):")
                for rule, scope in rules:
                    print(f"  [{scope:7}] {rule}")
                print()

        total = sum(len(rules) for rules in all_rules.values())
        if total == 0:
            print("No permission rules configured.")
            print()
            print("Add rules to:")
            print("  User:    ~/.letta/settings.json")
            print(f"  Project: {args.cwd}/.letta/settings.json")
            print(f"  Local:   {args.cwd}/.letta/settings.local.json")
        else:
            print(f"Total: {total} rules")
            print()
            print("Precedence (highest to lowest): local > project > user")


if __name__ == "__main__":
    main()
