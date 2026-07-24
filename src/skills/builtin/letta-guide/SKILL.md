---
name: letta-guide
description: Answer questions about Letta itself from the official documentation. Use whenever the user asks how Letta works, what Letta (or you) can do, or how to set up or configure providers, models, channels, skills, memory, schedules, permissions, self-hosting, pricing, or billing — any "how do I…" or "can Letta…" question about the Letta product. Fetch the docs before answering; never answer Letta product questions from memory alone.
---

# Letta Guide

You are running inside Letta, but your training data about Letta's commands,
flags, settings, UI, pricing, and providers is out of date. Users lose trust
fastest when an agent confidently invents product details. This skill defines
how to answer questions about Letta correctly.

## Source route (in order)

1. **Self-inspection first for questions about THIS agent.** "What model are
   you using?", "what tools do you have?", "what's in your memory?" are
   questions about the running session, not the docs. Load the
   `self-configuration` skill for model or settings questions and use its
   backend-aware active configuration report. Use the system prompt, agent
   info, tool schemas, and MemFS for the other live facts. Do not infer active
   state from recent/default preference lists, and do not fetch docs for these.
2. **Fetch the docs index directly.** For product questions, run:

   ```bash
   node <SKILL_DIR>/scripts/fetch-letta-docs.mjs
   ```

   The helper retrieves `https://docs.letta.com/llms.txt` from the docs host,
   verifies its ETag against the body, and prints the paths to a current local
   copy and heading outline. Read the outline, then read the relevant index
   lines to pick the best page URL.
3. **Fetch the specific page directly.** Pass the exact canonical URL from the
   index back to the same helper, for example:

   ```bash
   node <SKILL_DIR>/scripts/fetch-letta-docs.mjs \
     --docs-url "https://docs.letta.com/configuration/models/index.md"
   ```

   Read the returned docs path before running the helper for another URL. The
   helper uses native HTTPS with a curl fallback; do not use `fetch_webpage`
   for the normal docs route because its upstream content cache may be stale.
   Cite the public doc URL so the user can go deeper.
4. **If direct retrieval fails**, use `fetch_webpage` only as a fallback with a
   fresh query parameter on the same official docs URL. Disclose that the
   fallback may be stale. If that also fails, say the docs are unreachable,
   give your best answer, and clearly mark it as possibly out of date with a
   link to https://docs.letta.com. Never silently fall back to memory.

## Hard rules

- **Never invent CLI commands, flags, slash commands, settings keys, config
  file shapes, or UI paths.** If something is not in the fetched docs and you
  cannot verify it locally (`letta --help`, `/help`, reading the actual
  config file), say you are not sure or that it does not exist — do not
  guess a plausible-sounding name.
- **Distinguish surfaces.** The CLI, the desktop app, the web app
  (chat.letta.com), and the API/SDK have different affordances. Answer for
  the surface the user is actually on; say when a feature lives on a
  different surface.
- **Always fetch, never recall**, for anything volatile: pricing, rate
  limits, data policies, the provider/model catalog, channel setup steps,
  and integration instructions.
- **If the feature genuinely doesn't exist**, say so and point the user to
  https://github.com/letta-ai/letta-code/issues to request it.

## Support escalation

When the docs don't resolve the user's problem — setup issues you can't
debug, account/billing questions, suspected bugs, or anything needing a
human — point them to the right channel:

- **Discord** (https://discord.gg/letta): the primary support community,
  very active — best for setup help, troubleshooting, and quick questions.
  It's also where users can chat with **Ezra**, Letta's support agent.
- **GitHub issues** (https://github.com/letta-ai/letta-code/issues): bug
  reports and feature requests.

If the user reports errors, timeouts, or things suddenly not working, check
**https://status.letta.com** for an active incident before debugging — and
have the user check it too.

Offer these proactively when you've hit the end of what the docs cover,
rather than leaving the user stuck.

## Caching

The helper owns the cache. It uses the first writable temporary directory from
`TMPDIR`, `TEMP`, `TMP`, `/private/tmp`, or `/tmp`, and accepts `--cache-dir`
when an explicit location is needed. Every invocation checks the live ETag and
reuses the local document only when its body hash still matches. Do not create
or manage a second cache yourself.

