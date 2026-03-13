# System Prompts

## Letta-tuned prompt

- **letta.md** — The default Letta Code system prompt, written from scratch for the Letta Code agent.

## Source-faithful prompts

These are near-verbatim captures of competitor system prompts, used for benchmarking. They are rendered/assembled versions of the original modular prompts, with dynamic session context (env blocks, directory structures, git status) stripped.

### source_claude.md

- **Source:** Claude Code (Anthropic)
- **Version:** ~v2.1.50 (Feb 2026) — assembled from modular prompt files
- **Reference:** https://github.com/Piebald-AI/claude-code-system-prompts
- **Notes:** Since v2.1.20 the prompt is composed from ~110 atomic files at runtime. This is the rendered assembly for a default session (no custom output style, standard tools, TodoWrite present, Explore subagent available).

### source_codex.md

- **Source:** OpenAI Codex CLI (gpt-5.3-codex model)
- **Version:** Extracted from codex-rs/core/models.json, base_instructions for gpt-5.3-codex
- **Reference:** https://github.com/openai/codex
- **Notes:** gpt-5.3-codex is the latest model. Its prompt differs significantly from the older gpt-5.1-codex-max_prompt.md file: adds Personality section, commentary/final channels, intermediary updates, and removes the Plan tool section.

### source_gemini.md

- **Source:** Gemini CLI (Google)
- **Version:** snippets.ts (Feb 2026, copyright 2026 Google LLC)
- **Reference:** https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/prompts/snippets.ts
- **Notes:** Rendered for interactive mode, git repo present, outside sandbox, standard tools, no sub-agents, no skills, no YOLO mode, no approved plan. Tool name variables resolved. Conditional sections (YOLO mode, Plan mode, sandbox, GEMINI.md) noted but not inlined.
