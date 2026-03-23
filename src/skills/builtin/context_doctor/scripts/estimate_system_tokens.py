#!/usr/bin/env python3
"""Estimate token usage for system/ memory files.

This is a rough estimator intended for context-health checks, not billing.

Usage:
  python3 src/skills/builtin/context_doctor/scripts/estimate_system_tokens.py
  python3 src/skills/builtin/context_doctor/scripts/estimate_system_tokens.py --memory-dir /path/to/memory
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Estimate token count for system/ memory files.")
    parser.add_argument(
        "--memory-dir",
        type=Path,
        default=None,
        help="Path to memory root (defaults to $MEMORY_DIR).",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=10,
        help="How many largest files to print (default: 10).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    memory_dir = args.memory_dir or Path(os.environ.get("MEMORY_DIR", ""))
    if not memory_dir:
        print("Error: --memory-dir not provided and MEMORY_DIR is not set.")
        return 1
    if not memory_dir.exists():
        print(f"Error: memory dir does not exist: {memory_dir}")
        return 1

    system_dir = memory_dir / "system"
    if not system_dir.exists():
        print(f"Error: system directory not found: {system_dir}")
        return 1

    files = sorted(system_dir.rglob("*.md"))
    if not files:
        print(f"No markdown files found under: {system_dir}")
        return 0

    rows: list[tuple[str, int]] = []
    total_chars = 0
    for file_path in files:
        text = file_path.read_text(encoding="utf-8")
        chars = len(text)
        total_chars += chars
        rows.append((file_path.relative_to(memory_dir).as_posix(), chars))

    # Rough heuristics only.
    # - 4 chars/token is a common quick estimate for English prose.
    # - 3.6 chars/token tends to be a little denser for mixed prompt/code text.
    token_est_4 = round(total_chars / 4.0)
    token_est_3_6 = round(total_chars / 3.6)

    print("System memory token estimate (rough)")
    print(f"memory_dir: {memory_dir}")
    print(f"files: {len(rows)}")
    print(f"total_chars: {total_chars}")
    print(f"estimated_tokens_4_chars_per_token: {token_est_4}")
    print(f"estimated_tokens_3.6_chars_per_token: {token_est_3_6}")

    print("\nPer-file estimates:")
    print("chars\ttokens@4.0\ttokens@3.6\tpath")
    for path, chars in sorted(rows, key=lambda x: x[0]):
        per_file_4 = round(chars / 4.0)
        per_file_3_6 = round(chars / 3.6)
        print(f"{chars}\t{per_file_4}\t{per_file_3_6}\t{path}")

    print("\nLargest files by character count:")

    for path, chars in sorted(rows, key=lambda x: x[1], reverse=True)[: max(0, args.top)]:
        print(f"{chars:>8}  {path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
