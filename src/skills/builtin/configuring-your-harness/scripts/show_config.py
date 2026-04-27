#!/usr/bin/env python3
"""
Show the merged Letta Code harness configuration.

Displays permissions, hooks, and per-agent settings across user/project/local
scopes with their source scope annotated.

Usage:
    python3 show_config.py
    python3 show_config.py --cwd /path/to/project
    python3 show_config.py --json
"""

import argparse
import json
import os
from pathlib import Path


def get_settings_paths(working_directory: str) -> list[tuple[str, Path]]:
    """Return (scope, path) in precedence order (lowest to highest)."""
    return [
        ("user", Path.home() / ".letta" / "settings.json"),
        ("project", Path(working_directory) / ".letta" / "settings.json"),
        ("local", Path(working_directory) / ".letta" / "settings.local.json"),
    ]


def load_settings(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def format_permissions(
    all_settings: list[tuple[str, dict]], as_json: bool
) -> dict | None:
    """Collect permissions from all scopes with sources."""
    rules: dict[str, list[tuple[str, str]]] = {"allow": [], "deny": [], "ask": []}
    for scope, settings in all_settings:
        perms = settings.get("permissions", {})
        for rule_type in ["allow", "deny", "ask"]:
            for rule in perms.get(rule_type, []):
                rules[rule_type].append((rule, scope))

    if as_json:
        return {
            t: [{"rule": r, "scope": s} for r, s in rules[t]] for t in rules if rules[t]
        }

    total = sum(len(v) for v in rules.values())
    print("=" * 60)
    print(f"PERMISSIONS ({total} rules)")
    print("=" * 60)
    if total == 0:
        print("  (none)")
    else:
        for rule_type in ["allow", "deny", "ask"]:
            if rules[rule_type]:
                print(f"\n  {rule_type.upper()}:")
                for rule, scope in rules[rule_type]:
                    print(f"    [{scope:7}] {rule}")
    print()
    return None


def format_hooks(all_settings: list[tuple[str, dict]], as_json: bool) -> dict | None:
    """Collect hooks from all scopes with sources."""
    collected: dict[str, list[tuple[str, dict]]] = {}
    for scope, settings in all_settings:
        hooks = settings.get("hooks", {})
        if not isinstance(hooks, dict):
            continue
        for event, entries in hooks.items():
            if event == "disabled":
                continue
            if not isinstance(entries, list):
                continue
            collected.setdefault(event, []).extend((scope, e) for e in entries)

    if as_json:
        return {
            event: [
                {"scope": scope, **entry}
                for scope, entry in entries
            ]
            for event, entries in collected.items()
        }

    total_groups = sum(len(v) for v in collected.values())
    print("=" * 60)
    print(f"HOOKS ({len(collected)} events, {total_groups} groups)")
    print("=" * 60)
    if not collected:
        print("  (none)")
    else:
        for event, entries in sorted(collected.items()):
            print(f"\n  {event}:")
            for scope, entry in entries:
                matcher = entry.get("matcher", "(no matcher)")
                hook_list = entry.get("hooks", [])
                for h in hook_list:
                    htype = h.get("type", "?")
                    detail = h.get("command") or h.get("prompt", "")
                    detail = (
                        (detail[:60] + "...") if len(detail) > 60 else detail
                    )
                    print(f"    [{scope:7}] matcher={matcher:15} {htype}: {detail}")
    print()
    return None


def format_agents(all_settings: list[tuple[str, dict]], as_json: bool) -> dict | None:
    """Collect per-agent settings (only from user settings.json)."""
    agents = []
    for scope, settings in all_settings:
        for a in settings.get("agents", []):
            agents.append({"scope": scope, **a})

    if as_json:
        return agents

    print("=" * 60)
    print(f"PER-AGENT SETTINGS ({len(agents)} entries)")
    print("=" * 60)
    if not agents:
        print("  (none)")
    else:
        for a in agents:
            scope = a.get("scope", "?")
            aid = a.get("agentId", "?")
            print(f"\n  [{scope:7}] {aid}")
            for k in ("pinned", "memfs", "toolset", "systemPromptPreset", "baseUrl"):
                if k in a:
                    val = a[k]
                    if isinstance(val, dict):
                        val = json.dumps(val)
                    print(f"    {k}: {val}")
    print()
    return None


def format_settings_files(working_directory: str) -> None:
    print("=" * 60)
    print("SETTINGS FILES")
    print("=" * 60)
    for scope, path in get_settings_paths(working_directory):
        exists = "✓" if path.exists() else "✗"
        print(f"  {exists} [{scope:7}] {path}")
    print()


def main():
    parser = argparse.ArgumentParser(
        description="Show Letta Code harness configuration (permissions, hooks, agents)"
    )
    parser.add_argument(
        "--cwd",
        default=os.getcwd(),
        help="Working directory for project/local scope (default: cwd)",
    )
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument(
        "--section",
        choices=["permissions", "hooks", "agents", "all"],
        default="all",
        help="Which section to show (default: all)",
    )

    args = parser.parse_args()

    all_settings = [
        (scope, load_settings(path))
        for scope, path in get_settings_paths(args.cwd)
    ]

    if args.json:
        output: dict = {}
        if args.section in ("permissions", "all"):
            perms = format_permissions(all_settings, as_json=True)
            if perms:
                output["permissions"] = perms
        if args.section in ("hooks", "all"):
            hooks = format_hooks(all_settings, as_json=True)
            if hooks:
                output["hooks"] = hooks
        if args.section in ("agents", "all"):
            agents = format_agents(all_settings, as_json=True)
            if agents:
                output["agents"] = agents
        print(json.dumps(output, indent=2))
    else:
        print(f"\nLetta Code Harness Configuration")
        print(f"Working directory: {args.cwd}\n")
        if args.section == "all":
            format_settings_files(args.cwd)
        if args.section in ("permissions", "all"):
            format_permissions(all_settings, as_json=False)
        if args.section in ("hooks", "all"):
            format_hooks(all_settings, as_json=False)
        if args.section in ("agents", "all"):
            format_agents(all_settings, as_json=False)
        print("Precedence (highest to lowest): local > project > user\n")


if __name__ == "__main__":
    main()
