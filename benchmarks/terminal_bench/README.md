# Terminal-Bench Regression

Weekly regression tests for Letta Code on [Terminal-Bench 2.0](https://github.com/laude-institute/terminal-bench-2).

## How it works

1. **GitHub Actions** (`.github/workflows/terminal-bench-regression.yml`) runs every Monday at 5am PT
2. **Harbor** orchestrates task execution in **Modal** cloud sandboxes
3. Letta Code is built from source (`main` branch) inside each sandbox
4. Results are compared against `baseline.json` and posted to a GitHub issue
5. `@devanshrj` is tagged if any model drops >5% from baseline

## Models

| Model | Baseline |
|-------|----------|
| `sonnet-4.6-xhigh` | 38/89 (42.7%) |
| `gpt-5.3-codex-xhigh` | 57/89 (64.0%) |

## Files

| File | Description |
|------|-------------|
| `letta_code_agent.py` | Harbor agent — installs and runs Letta Code CLI in sandbox |
| `install-letta-code.sh.j2` | Jinja2 install script (Node.js, Bun, build from source) |
| `baseline.json` | Per-model, per-task pass/fail baselines |
| `report.py` | Parses results, detects regressions, posts GitHub issue |

## Manual trigger

```bash
gh workflow run terminal-bench-regression.yml --ref main -f concurrency=10
```

## Required secrets

- `LETTA_API_KEY` — Letta Cloud API key
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — LLM provider keys
- `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` — Modal sandbox credentials

## Updating baselines

Replace `baseline.json` with results from a new run. Format:

```json
{
  "model-name": {
    "pass_rate": 0.427,
    "tasks": {
      "task-name": true,
      ...
    }
  }
}
```
