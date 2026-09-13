---
name: customizing-statusline
description: Creates, edits, and migrates Letta Code statusline mods. Use when handling the /statusline command or continuing work started by /statusline.
---

# Customizing Statusline

Use this skill to create or update the global Letta Code statusline mod:

```text
~/.letta/mods/statusline.tsx
```

The statusline is a panel registered at `order: 0` — the primary line just below the input. It overrides the built-in `agent · model` line. Host UI can still temporarily preempt it for safety confirmations and transient hints.

## Statusline ownership model

```text
safety preemption
else transient host hint
else order-0 statusline panel
else built-in default statusline
```

The order-0 panel owns the whole primary row. It renders text (not React) and owns its own layout via the `row`/`columns` helpers.

## Workflow

1. Check whether `~/.letta/mods/statusline.tsx` exists.
2. If it exists, read it before editing and preserve unrelated code.
3. If it does not exist, synthesize a focused starter for the user's request.
4. If the user asks to migrate, import a `.sh` file, or match a shell prompt, read `references/migration.md`.
5. If API details or concrete patterns are needed, read `references/api.md` and `references/examples.md`.
6. If the request combines statusline work with commands, tools, events, other panels, or stateful mod behavior, also use `creating-mods` and its `references/architecture.md`.
7. Guard panel work with `letta.capabilities.ui.panels` when writing new files.
8. Edit `~/.letta/mods/statusline.tsx`.
9. Summarize the absolute file path changed and tell the user to run `/reload` unless the command can reload automatically.

## Bare `/statusline` behavior

If the user ran `/statusline` without a specific request:

- If a custom statusline file exists, summarize what it appears to do and ask what they want to change.
- If no custom file exists, explain that Letta is using the built-in default statusline and offer focused next steps:
  1. start from a simple `agent · model` statusline
  2. add project info like git branch, worktree, or PR
  3. migrate an existing legacy statusline `.sh` file
  4. match shell prompt / PS1
  5. describe a custom statusline in their own words

Keep this conversational. Do not build a menu UI unless the product command explicitly asks for one.

## Rules

- Global-only for now. Do not create project mods.
- Keep the mod single-file for MVP.
- Do not assume extra npm packages are available.
- Do not use relative multi-file imports yet.
- Keep `render` synchronous and side-effect-free. Do not shell, fetch, await, or read files inside render.
- Do async work in setup code, intervals, or subscriptions, store the result in a closure variable, then call `panel.update()` to re-render.
- Register the statusline at `order: 0`. Compose left/right with `row(left, right, width)`; color with `chalk`.
- Guard panel work with `letta.capabilities.ui.panels` in new files.
- Return a disposer that clears timers/subscriptions and calls `panel.close()`.
- Preserve existing mod code unless the user asks to reset.

## Useful references

- `references/api.md` - panel API, render context, lifecycle rules
- `references/examples.md` - common statusline patterns
- `references/migration.md` - legacy command `.sh` and PS1 migration
