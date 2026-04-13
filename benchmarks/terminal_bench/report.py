#!/usr/bin/env python3
"""Parse Harbor job results and report regressions via GitHub Issue.

Usage:
    python report.py --results-dir results/ --baseline baseline.json --repo owner/repo

Expects Harbor job output structure under results-dir:
    results/
      tb-results-<model>/
        jobs/
          <job-name>/
            result.json
            <task-name>/
              result.json        # trial result with reward
              verifier/
                reward.txt       # 0.0 or 1.0
"""

import argparse
import json
import os
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def classify_failure(result: dict) -> str:
    """Return a short error label for a failed task, or empty string if it's just a wrong answer."""
    exception_info = result.get("exception_info") or {}
    exc_type = exception_info.get("exception_type", "")

    if exc_type:
        return exc_type

    # No exception — check agent return code.
    agent_result = result.get("agent_result") or {}
    metadata = agent_result.get("metadata") or {}
    rc = metadata.get("letta_return_code")
    if rc is not None and rc != 0:
        return f"agent-error (rc {rc})"

    return ""



def parse_job_results(results_dir: Path) -> dict[str, dict]:
    """Parse Harbor job results into {model: {tasks, cost, failures}}."""
    model_results: dict[str, dict] = {}

    for artifact_dir in sorted(results_dir.iterdir()):
        if not artifact_dir.is_dir():
            continue

        # Artifact name: tb-results-<model>
        dir_name = artifact_dir.name
        if dir_name.startswith("tb-results-"):
            model = dir_name[len("tb-results-"):]
        else:
            model = dir_name

        tasks: dict[str, bool] = {}
        failures: dict[str, dict] = {}
        total_cost = 0.0
        total_prompt_tokens = 0
        total_completion_tokens = 0

        # Look for job directories — Harbor puts them under jobs/
        jobs_dir = artifact_dir / "jobs"
        if not jobs_dir.exists():
            # Artifacts might be flat (just the job contents)
            jobs_dir = artifact_dir

        for job_dir in sorted(jobs_dir.iterdir()):
            if not job_dir.is_dir():
                continue

            # Each subdirectory of the job is a trial (task)
            for trial_dir in sorted(job_dir.iterdir()):
                if not trial_dir.is_dir():
                    continue

                # Skip non-trial dirs like config.json
                task_name = trial_dir.name

                result_data: dict | None = None
                result_file = trial_dir / "result.json"
                if result_file.exists():
                    try:
                        result_data = json.loads(result_file.read_text())
                    except (json.JSONDecodeError, OSError):
                        pass

                # Try verifier/reward.txt first
                reward_file = trial_dir / "verifier" / "reward.txt"
                if reward_file.exists():
                    try:
                        reward = float(reward_file.read_text().strip())
                        tasks[task_name] = reward >= 1.0
                    except (ValueError, OSError):
                        pass

                if task_name not in tasks:
                    # Fall back to result.json
                    if result_data is not None:
                        try:
                            reward = result_data.get("reward", result_data.get("score", 0))
                            tasks[task_name] = float(reward) >= 1.0
                        except (ValueError, TypeError):
                            tasks[task_name] = False
                    elif result_file.exists():
                        tasks[task_name] = False

                # Classify failures (skip wrong answers — only track actual errors)
                if task_name in tasks and not tasks[task_name] and result_data is not None:
                    error_label = classify_failure(result_data)
                    if error_label:
                        failures[task_name] = error_label

                # Collect cost from usage.json
                usage_file = trial_dir / "usage.json"
                if usage_file.exists():
                    try:
                        usage = json.loads(usage_file.read_text())
                        total_cost += usage.get("cost_usd", 0.0)
                        total_prompt_tokens += usage.get("prompt_tokens", 0)
                        total_completion_tokens += usage.get("completion_tokens", 0)
                    except (json.JSONDecodeError, OSError):
                        pass

        if tasks:
            model_results[model] = {
                "tasks": tasks,
                "failures": failures,
                "cost": {
                    "cost_usd": round(total_cost, 2),
                    "prompt_tokens": total_prompt_tokens,
                    "completion_tokens": total_completion_tokens,
                },
            }

    return model_results


def compute_pass_rate(tasks: dict[str, bool]) -> float:
    """Compute pass rate from task results."""
    if not tasks:
        return 0.0
    return sum(1 for v in tasks.values() if v) / len(tasks)


def load_baseline(baseline_path: Path) -> dict:
    """Load baseline.json, returning empty dict if missing or empty."""
    if not baseline_path.exists():
        return {}
    try:
        data = json.loads(baseline_path.read_text())
        return data if isinstance(data, dict) and data else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _failure_annotation(task_name: str, failures: dict[str, str]) -> str:
    """Return a parenthesized annotation for a failed task, or empty string."""
    label = failures.get(task_name)
    if not label:
        return ""
    return f" ({label})"


def build_report(
    model_results: dict[str, dict],
    baseline: dict,
) -> tuple[str, bool]:
    """Build a markdown report and determine if there's a regression.

    Returns (markdown_body, has_regression).
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"## Terminal-Bench Regression Report — {now}",
        "",
    ]

    has_regression = False

    for model, data in sorted(model_results.items()):
        tasks = data["tasks"]
        failures = data.get("failures", {})
        cost = data.get("cost", {})
        pass_rate = compute_pass_rate(tasks)
        passed = sum(1 for v in tasks.values() if v)
        total = len(tasks)
        n_errors = len(failures)

        # Compare to baseline
        baseline_model = baseline.get(model, {})
        baseline_rate = baseline_model.get("pass_rate")
        baseline_tasks = baseline_model.get("tasks", {})

        delta_str = ""
        if baseline_rate is not None:
            delta = pass_rate - baseline_rate
            if delta < -0.05:
                has_regression = True
                delta_str = f" | **{delta:+.0%} from baseline** :red_circle:"
            elif delta < 0:
                delta_str = f" | {delta:+.0%} from baseline :warning:"
            elif delta > 0:
                delta_str = f" | {delta:+.0%} from baseline :white_check_mark:"

        error_str = ""
        if n_errors > 0:
            error_str = f" | {n_errors} errors"

        cost_str = ""
        cost_usd = cost.get("cost_usd", 0)
        if cost_usd > 0:
            cost_str = f" | ${cost_usd:.2f}"

        lines.append("<details>")
        lines.append(f"<summary><strong>{model}</strong> — {passed}/{total} ({pass_rate:.0%}){delta_str}{error_str}{cost_str}</summary>")
        lines.append("")

        # Error breakdown table
        if failures:
            category_counts = Counter(failures.values())
            lines.append(f"**Error breakdown ({n_errors} failures):**")
            lines.append("| Category | Count |")
            lines.append("|---|---|")
            for cat, count in category_counts.most_common():
                lines.append(f"| {cat} | {count} |")
            lines.append("")

        # Categorize tasks
        regressions = []  # was passing, now failing
        improvements = []  # was failing, now passing
        new_tasks = []  # not in baseline

        for task_name, passed_now in sorted(tasks.items()):
            baseline_val = baseline_tasks.get(task_name)
            if baseline_val is None:
                new_tasks.append((task_name, passed_now))
            elif baseline_val and not passed_now:
                regressions.append(task_name)
                has_regression = True
            elif not baseline_val and passed_now:
                improvements.append(task_name)

        if regressions:
            lines.append(f"**Regressions ({len(regressions)}):**")
            for t in regressions:
                lines.append(f"- :red_circle: {t}{_failure_annotation(t, failures)}")
            lines.append("")

        if improvements:
            lines.append(f"**Improvements ({len(improvements)}):**")
            for t in improvements:
                lines.append(f"- :white_check_mark: {t}")
            lines.append("")

        if new_tasks:
            new_passed = sum(1 for _, p in new_tasks if p)
            lines.append(f"**New tasks ({new_passed}/{len(new_tasks)} passed):**")
            for t, p in new_tasks:
                emoji = ":white_check_mark:" if p else ":x:"
                annotation = _failure_annotation(t, failures) if not p else ""
                lines.append(f"- {emoji} {t}{annotation}")
            lines.append("")

        if not regressions and not improvements and not new_tasks:
            lines.append("No changes from baseline.")
            lines.append("")

        lines.append("</details>")
        lines.append("")

    if not model_results:
        lines.append("No results found. Check workflow logs.")
        lines.append("")

    # Add workflow link
    run_url = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    if repo and run_id:
        lines.append(f"[Workflow run]({run_url}/{repo}/actions/runs/{run_id})")
        lines.append("")

    if has_regression:
        lines.append("cc @devanshrj")
        lines.append("")

    return "\n".join(lines), has_regression


def update_github_issue(repo: str, title: str, body: str) -> None:
    """Create or update a GitHub Issue with the given title and body.

    Uses `gh` CLI which must be authenticated via GH_TOKEN env var.
    """
    # Search for existing issue
    result = subprocess.run(
        ["gh", "issue", "list", "--repo", repo, "--search", f'"{title}" in:title', "--state", "open", "--json", "number", "--limit", "1"],
        capture_output=True,
        text=True,
    )

    existing_number = None
    if result.returncode == 0 and result.stdout.strip():
        try:
            issues = json.loads(result.stdout)
            if issues:
                existing_number = issues[0]["number"]
        except (json.JSONDecodeError, KeyError, IndexError):
            pass

    if existing_number:
        # Update existing issue with a comment
        subprocess.run(
            ["gh", "issue", "comment", str(existing_number), "--repo", repo, "--body", body],
            check=True,
        )
        print(f"Updated issue #{existing_number}")
    else:
        # Create new issue
        result = subprocess.run(
            ["gh", "issue", "create", "--repo", repo, "--title", title, "--body", body, "--label", "benchmark"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            print(f"Created issue: {result.stdout.strip()}")
        else:
            # Label might not exist — retry without it
            subprocess.run(
                ["gh", "issue", "create", "--repo", repo, "--title", title, "--body", body],
                check=True,
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="Report Terminal-Bench regression results")
    parser.add_argument("--results-dir", required=True, type=Path, help="Directory with downloaded artifacts")
    parser.add_argument("--baseline", required=True, type=Path, help="Path to baseline.json")
    parser.add_argument("--repo", required=True, help="GitHub repo (owner/repo)")
    args = parser.parse_args()

    model_results = parse_job_results(args.results_dir)
    baseline = load_baseline(args.baseline)

    if not model_results:
        print("WARNING: No results parsed from artifacts.")
        print(f"Contents of {args.results_dir}:")
        for p in sorted(args.results_dir.rglob("*")):
            print(f"  {p}")
        sys.exit(1)

    body, has_regression = build_report(model_results, baseline)

    # Print report to stdout
    print(body)

    # Update GitHub Issue
    gh_token = os.environ.get("GH_TOKEN")
    if gh_token:
        update_github_issue(
            repo=args.repo,
            title="Terminal-Bench tracker",
            body=body,
        )
    else:
        print("GH_TOKEN not set — skipping GitHub Issue update")

    if has_regression:
        print("\n:red_circle: REGRESSION DETECTED — failing workflow")
        sys.exit(1)
    else:
        print("\nNo regressions detected.")


if __name__ == "__main__":
    main()
