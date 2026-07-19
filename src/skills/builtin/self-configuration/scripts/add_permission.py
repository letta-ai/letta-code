#!/usr/bin/env python3
"""
Add a permission rule to Letta Code settings.

Usage:
    python3 add_permission.py --rule "Bash(npm run:*)" --type allow --scope user --confirm-user-scope
    python3 add_permission.py --rule "Read(src/**)" --type allow --scope project
    python3 add_permission.py --rule "Bash(git push:*)" --type alwaysAsk --scope user --confirm-user-scope
    python3 add_permission.py --rule "Read(src/**)" --type allow --scope project --dry-run
"""

import argparse
import json
import os
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any


def get_settings_path(scope: str, working_directory: str) -> Path:
    """Get the settings file path for a given scope."""
    if scope == "user":
        return Path.home() / ".letta" / "settings.json"
    if scope == "project":
        return Path(working_directory) / ".letta" / "settings.json"
    if scope == "local":
        return Path(working_directory) / ".letta" / "settings.local.json"
    raise ValueError(f"Unknown scope: {scope}")


def load_settings(path: Path) -> dict[str, Any]:
    """Load settings from a JSON object file, or return empty dict if not found."""
    if not path.exists():
        return {}

    try:
        with open(path, encoding="utf-8") as f:
            parsed = json.load(f)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Malformed JSON in {path}; refusing to overwrite it") from exc
    except OSError as exc:
        raise ValueError(f"Could not read {path}: {exc}") from exc

    if not isinstance(parsed, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return parsed


def save_settings(path: Path, settings: dict[str, Any]) -> None:
    """Atomically save settings, preserving an existing file mode where practical."""
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else None
    temp_path: str | None = None

    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as f:
            temp_path = f.name
            json.dump(settings, f, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(temp_path, mode)
        os.replace(temp_path, path)
    except Exception:
        if temp_path is not None:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
        raise

    print(f"Saved to {path}")


def add_rule(settings: dict[str, Any], rule: str, rule_type: str) -> bool:
    """
    Add a permission rule to settings.

    Returns True if the rule was added, False if it already exists.
    """
    permissions = settings.setdefault("permissions", {})
    if not isinstance(permissions, dict):
        raise ValueError("settings.permissions must be an object")

    raw_rules = permissions.setdefault(rule_type, [])
    if not isinstance(raw_rules, list):
        raise ValueError(f"settings.permissions.{rule_type} must be a list")

    if rule in raw_rules:
        return False

    raw_rules.append(rule)
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
            with open(gitignore_path, "a", encoding="utf-8") as f:
                if content and not content.endswith("\n"):
                    f.write("\n")
                f.write(f"{pattern}\n")
            print(f"Added {pattern} to .gitignore")
    except Exception as e:
        print(f"Warning: Could not update .gitignore: {e}", file=sys.stderr)


def main() -> None:
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
        choices=["allow", "deny", "ask", "alwaysAsk"],
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
    parser.add_argument(
        "--confirm-user-scope",
        action="store_true",
        help="Required for writes to ~/.letta/settings.json",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview whether the rule would be added without writing settings",
    )

    args = parser.parse_args()

    if args.scope == "user" and not args.confirm_user_scope and not args.dry_run:
        print(
            "Refusing to modify user/global settings without --confirm-user-scope; user-scope permission rules affect all agents for this account.",
            file=sys.stderr,
        )
        sys.exit(1)

    settings_path = get_settings_path(args.scope, args.cwd)
    try:
        settings = load_settings(settings_path)
        added = add_rule(settings, args.rule, args.type)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

    if args.dry_run:
        print(
            json.dumps(
                {
                    "path": str(settings_path),
                    "scope": args.scope,
                    "type": args.type,
                    "rule": args.rule,
                    "would_add": added,
                },
                indent=2,
            )
        )
        return

    if added:
        try:
            save_settings(settings_path, settings)
        except OSError as exc:
            print(f"Could not save {settings_path}: {exc}", file=sys.stderr)
            sys.exit(1)
        print(f"Added {args.type} rule: {args.rule}")

        # Ensure local settings are gitignored
        if args.scope == "local":
            ensure_local_gitignored(args.cwd)
    else:
        print(f"Rule already exists: {args.rule}")
        sys.exit(0)


if __name__ == "__main__":
    main()
