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
   questions about the running session, not the docs. Answer them from the
   live environment: your system prompt and agent info, `/status`-style
   command surfaces, settings files, and MemFS. Do not fetch docs for these.
2. **Fetch the docs index.** For product questions, fetch
   `https://docs.letta.com/llms.txt` — a curated index of every current
   documentation page with descriptions. Pick the most relevant page URLs.
3. **Fetch the specific pages.** Append `/index.md` to any docs URL for the
   canonical LLM-friendly markdown version (e.g.
   `https://docs.letta.com/configuration/models/index.md`). Read the page,
   then answer. Cite the doc URL(s) you used so the user can go deeper.
4. **If the docs are unreachable**, say so explicitly, give your best answer,
   and clearly mark it as possibly out of date with a link to
   https://docs.letta.com. Never silently fall back to memory.

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

Cache fetched pages under the Letta home directory: `~/.letta/docs-cache/`
(Windows: `%USERPROFILE%\.letta\docs-cache\`). Resolve `~` to an absolute
path before passing paths to file tools — they do not expand it. Reuse cached
pages within a session; refetch `llms.txt` when the cached copy is older than
about a day.

