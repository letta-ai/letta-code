---
name: generating-mod-envs
description: Generates and reviews mod learning env JSON files for Letta Code local mods. Use when asked to teach, learn, or optimize a mod behavior; create, draft, validate, improve, or explain envs for `/mods learn --env`; or design evaluation scenarios, memory fixtures, requiredResultMarkers, requiredTraceMarkers, negative controls, and candidate diversity hints.
disable-model-invocation: true
user-invocable: true
---

# Generating mod learning envs

Use this skill to create JSON envs consumed by `/mods learn --env=<path>` or `bun scripts/mod-learning/learn-mod.ts --env <path>`. An env describes the mod behavior to learn and the scenario-suite eval used to score candidates.

## Workflow

1. Define the behavior and eval before writing JSON.
   - What should the mod do? Tool, turn event, tool event, provider, command, status, etc.
   - What would a placebo/no-op mod fail?
   - What unique sentinel strings make success unambiguous?
2. Choose a path:
   - Repo example: `docs/examples/mods/learning/<slug>.env.json`
   - Local/private: any user-requested path
3. Draft strict JSON. Start from `assets/mod-learning-env.template.json` if useful. No comments or trailing commas.
4. Prefer `evaluation.scenarios` with at least:
   - happy path
   - discrimination/exact-target path
   - negative control
5. Validate:

```bash
bun src/skills/builtin/generating-mod-envs/scripts/validate-mod-env.ts path/to/env.json
```

If this skill is installed outside the source tree, run the same script from this skill directory: `scripts/validate-mod-env.ts`.

6. If asked to run it:

```text
/mods learn --env=path/to/env.json --model=auto --backend=api --out=/tmp/<slug>-learn
```

The raw `scripts/mod-learning/learn-mod.ts` dev script detaches by default. Add `--foreground` only when a blocking pass/fail exit code is needed.

Use single-line `--flag=value` commands for TUI instructions.

## Env shape

Required top-level fields:

- `name`: human display name.
- `slug`: stable kebab-case run/candidate slug.
- `objective`: one-paragraph target for the generation agent.
- `requirements`: concrete pass/fail behavior constraints.
- `evaluation`: either a single prompt eval or a scenario suite.

Common optional fields:

- `targetModName`: display metadata for the intended mod filename. The harness still chooses the candidate filename from `slug` unless `--candidate-file-name` is passed.
- `candidateDiversityHints`: strategies assigned across multi-candidate runs.
- `modApiHints`: concise API reminders that prevent bad generated code.
- `examples`: small input/expected demos for the generation prompt.

Evaluation fields:

- `evaluation.outputFormat`: use `stream-json` when checking trace markers.
- `evaluation.timeoutMs`, `evaluation.maxTurns`: per-scenario defaults.
- `evaluation.memoryFiles`: files seeded under eval `$MEMORY_DIR`.
- `evaluation.scenarios[]`: scenario-specific overrides and fixtures.
- In scenario-suite envs, do not add a top-level `evaluation.prompt` unless that prompt must run for every scenario. Assertion-only scenarios should have `assertions` and no `prompt`; only scenarios that require model behavior should define `scenario.prompt`.
- `requiredResultMarkers`: literal strings required in the final answer.
- `requiredTraceMarkers`: literal strings required in raw stdout/stderr.
- `forbiddenResultMarkers`: final-answer strings that fail the run.
- `forbiddenTraceMarkers`: raw trace strings that fail the run.

## Quality rules

- Design the eval first. A useful env distinguishes success from a no-op mod.
- Use unique sentinels, e.g. `MY-MOD-CANARY-OK`, not common phrases.
- Seed `memoryFiles` rather than depending on real user memory or repo files.
- Include negative controls for non-use. If behavior should be conditional, verify it stays silent when not triggered.
- Include discrimination scenarios when paths, IDs, or sources matter. Put a tempting wrong sentinel in an irrelevant fixture and forbid it in the final answer.
- Put load failures in `forbiddenTraceMarkers`, usually:
  - `[mods] failed to load`
  - `[extensions] failed to load`
  - `loaded 0 mod(s)`
  - `loaded 0 extension(s)`
- For eval-facing tools, require `requiresApproval: false`, `parallelSafe: true`, and a strict no-argument schema when applicable.
- Avoid over-brittle trace markers. Prefer stable substrings like the tool name plus `"message_type":"tool_return_message"`.
- Keep requirements behavioral; put fragile implementation details in `modApiHints` only when needed.

## Minimal scenario-suite example

```json
{
  "name": "Hello tool mod learner demo",
  "slug": "hello-tool",
  "objective": "Learn a trusted local mod that registers a read-only hello_mod_ping tool returning a fixed sentinel.",
  "requirements": [
    "Register a tool named hello_mod_ping.",
    "The tool must accept no parameters, require no approval, be parallelSafe, and return the exact string HELLO-MOD-OK."
  ],
  "candidateDiversityHints": [
    "Use the smallest possible tool-only implementation.",
    "Add explicit defensive checks around the tool schema."
  ],
  "modApiHints": [
    "Use export function activate(letta) or a default export.",
    "Use letta.tools.register({ name, description, parameters, requiresApproval, parallelSafe, run }).",
    "A no-argument tool schema is { \"type\": \"object\", \"properties\": {}, \"additionalProperties\": false }."
  ],
  "evaluation": {
    "outputFormat": "stream-json",
    "timeoutMs": 900000,
    "maxTurns": 6,
    "forbiddenTraceMarkers": ["[mods] failed to load", "loaded 0 mod(s)"],
    "scenarios": [
      {
        "name": "happy-path",
        "prompt": "Call the hello_mod_ping tool, then answer with the exact text HELLO-MOD-OK.",
        "requiredResultMarkers": ["HELLO-MOD-OK"],
        "requiredTraceMarkers": ["hello_mod_ping", "\"message_type\":\"tool_return_message\""]
      },
      {
        "name": "negative-control",
        "prompt": "Answer without calling tools: what is 2 + 2?",
        "requiredResultMarkers": ["4"],
        "forbiddenTraceMarkers": ["hello_mod_ping"]
      }
    ]
  }
}
```
