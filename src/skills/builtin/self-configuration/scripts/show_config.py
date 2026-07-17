"""
Show relevant Letta Code self-configuration.

Displays settings files, permissions, selected runtime preferences, environment
keys, experiments, and per-agent settings across user/project/local scopes with
source scope annotated. Secret values are not printed.

Usage:
    python3 show_config.py
    python3 show_config.py --cwd /path/to/project
    python3 show_config.py --json
"""

import argparse
import json
import os
from pathlib import Path
from typing import Any


TOP_LEVEL_KEYS = [
    "tokenStreaming",
    "reasoningTabCycleEnabled",
    "showCompactions",
    "sessionContextEnabled",
    "autoConversationTitles",
    "autoSwapOnQuotaLimit",
    "includeWorktreeTool",
    "preferredBackendMode",
    "channelCredentialsStore",
    "reflectionTrigger",
    "reflectionStepCount",
    "conversationSwitchAlertEnabled",
    "createDefaultAgents",
    "windowTitle",
]


def get_settings_paths(working_directory: str) -> list[tuple[str, Path]]:
    """Return (scope, path) in precedence order (lowest to highest)."""
    return [
        ("user", Path.home() / ".letta" / "settings.json"),
        ("project", Path(working_directory) / ".letta" / "settings.json"),
        ("local", Path(working_directory) / ".letta" / "settings.local.json"),
    ]


def load_settings(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        with open(path) as f:
            parsed = json.load(f)
            return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def format_permissions(
    all_settings: list[tuple[str, dict[str, Any]]], as_json: bool
) -> dict[str, list[dict[str, str]]] | None:
    """Collect permissions from all scopes with sources."""
    rule_types = ["allow", "deny", "ask", "alwaysAsk"]
    rules: dict[str, list[tuple[str, str]]] = {rule_type: [] for rule_type in rule_types}
    for scope, settings in all_settings:
        perms = settings.get("permissions", {})
        if not isinstance(perms, dict):
            continue
        for rule_type in rule_types:
            values = perms.get(rule_type, [])
            if not isinstance(values, list):
                continue
            for rule in values:
                if isinstance(rule, str):
                    rules[rule_type].append((rule, scope))

    if as_json:
        return {
            rule_type: [{"rule": rule, "scope": scope} for rule, scope in entries]
            for rule_type, entries in rules.items()
            if entries
        }

    total = sum(len(v) for v in rules.values())
    print("=" * 60)
    print(f"PERMISSIONS ({total} rules)")
    print("=" * 60)
    if total == 0:
        print("  (none)")
    else:
        for rule_type in rule_types:
            if rules[rule_type]:
                print(f"\n  {rule_type.upper()}:")
                for rule, scope in rules[rule_type]:
                    print(f"    [{scope:7}] {rule}")
    print()
    return None


def render_safe_value(value: Any) -> str:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return json.dumps(value)
    return json.dumps(value, sort_keys=True)


def format_settings(
    all_settings: list[tuple[str, dict[str, Any]]], as_json: bool
) -> list[dict[str, Any]] | None:
    """Collect selected non-secret settings from all scopes."""
    rows: list[dict[str, Any]] = []
    for scope, settings in all_settings:
        for key in TOP_LEVEL_KEYS:
            if key in settings:
                rows.append({"scope": scope, "key": key, "value": settings[key]})
        env = settings.get("env")
        if isinstance(env, dict) and env:
            rows.append({"scope": scope, "key": "env_keys", "value": sorted(env.keys())})
        experiments = settings.get("experiments")
        if isinstance(experiments, dict) and experiments:
            rows.append({"scope": scope, "key": "experiments", "value": experiments})
        reflection_by_agent = settings.get("reflectionSettingsByAgent")
        if isinstance(reflection_by_agent, dict) and reflection_by_agent:
            rows.append(
                {
                    "scope": scope,
                    "key": "reflectionSettingsByAgent",
                    "value": reflection_by_agent,
                }
            )

    if as_json:
        return rows

    print("=" * 60)
    print(f"SELECTED SETTINGS ({len(rows)} entries)")
    print("=" * 60)
    if not rows:
        print("  (none)")
    else:
        for row in rows:
            print(
                f"  [{row['scope']:7}] {row['key']}: {render_safe_value(row['value'])}"
            )
    print()
    return None


def format_agents(
    all_settings: list[tuple[str, dict[str, Any]]], as_json: bool
) -> list[dict[str, Any]] | None:
    """Collect per-agent settings from all scopes."""
    agents: list[dict[str, Any]] = []
    for scope, settings in all_settings:
        raw_agents = settings.get("agents", [])
        if not isinstance(raw_agents, list):
            continue
        for agent in raw_agents:
            if isinstance(agent, dict):
                agents.append({"scope": scope, **agent})

    if as_json:
        return agents

    print("=" * 60)
    print(f"PER-AGENT SETTINGS ({len(agents)} entries)")
    print("=" * 60)
    if not agents:
        print("  (none)")
    else:
        for agent in agents:
            scope = agent.get("scope", "?")
            agent_id = agent.get("agentId", "?")
            print(f"\n  [{scope:7}] {agent_id}")
            for key in (
                "baseUrl",
                "pinned",
                "memfs",
                "toolset",
                "systemPromptPreset",
                "systemPromptHash",
                "systemPromptVersion",
            ):
                if key in agent:
                    print(f"    {key}: {render_safe_value(agent[key])}")
    print()
    return None


def format_settings_files(working_directory: str, as_json: bool) -> list[dict[str, Any]] | None:
    rows = [
        {"scope": scope, "path": str(path), "exists": path.exists()}
        for scope, path in get_settings_paths(working_directory)
    ]
    if as_json:
        return rows

    print("=" * 60)
    print("SETTINGS FILES")
    print("=" * 60)
    for row in rows:
        exists = "yes" if row["exists"] else "no"
        print(f"  {exists:3} [{row['scope']:7}] {row['path']}")
    print()
    return None


def main():
    parser = argparse.ArgumentParser(
        description="Show Letta Code self-configuration without dumping secret values"
    )
    parser.add_argument(
        "--cwd",
        default=os.getcwd(),
        help="Working directory for project/local scope (default: cwd)",
    )
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument(
        "--section",
        choices=["files", "permissions", "settings", "agents", "all"],
        default="all",
        help="Which section to show (default: all)",
    )

    args = parser.parse_args()

    all_settings = [
        (scope, load_settings(path))
        for scope, path in get_settings_paths(args.cwd)
    ]

    if args.json:
        output: dict[str, Any] = {}
        if args.section in ("files", "all"):
            output["files"] = format_settings_files(args.cwd, as_json=True)
        if args.section in ("permissions", "all"):
            output["permissions"] = format_permissions(all_settings, as_json=True)
        if args.section in ("settings", "all"):
            output["settings"] = format_settings(all_settings, as_json=True)
        if args.section in ("agents", "all"):
            output["agents"] = format_agents(all_settings, as_json=True)
        print(json.dumps(output, indent=2, sort_keys=True))
        return

    print("\nLetta Code Self-Configuration")
    print(f"Working directory: {args.cwd}\n")
    if args.section in ("files", "all"):
        format_settings_files(args.cwd, as_json=False)
    if args.section in ("permissions", "all"):
        format_permissions(all_settings, as_json=False)
    if args.section in ("settings", "all"):
        format_settings(all_settings, as_json=False)
    if args.section in ("agents", "all"):
        format_agents(all_settings, as_json=False)
    print("Precedence (highest to lowest): local > project > user\n")


if __name__ == "__main__":
    main()
