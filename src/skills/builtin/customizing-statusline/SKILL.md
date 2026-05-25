---
name: customizing-statusline
description: Creates, edits, and migrates Letta Code statusline extensions. Use when handling the /statusline command or continuing work started by /statusline.
---

# Customizing Statusline

Use this skill to create or update the global Letta Code statusline extension:

```text
~/.letta/extensions/statusline.tsx
```

The statusline is a full-row idle renderer. Host UI can still temporarily preempt it for safety confirmations and transient hints.

## Statusline ownership model

```text
safety preemption
else transient host hint
else custom statusline extension
else built-in default statusline
```

A custom statusline owns the whole idle row. Do not preserve legacy left/right split semantics in the new API.

## Workflow

1. Check whether `~/.letta/extensions/statusline.tsx` exists.
2. If it exists, read it before editing and preserve unrelated code.
3. If it does not exist, start from the built-in default template or synthesize a focused starter for the user's request.
4. If the user asks to migrate, import a `.sh` file, or match a shell prompt, read `references/migration.md`.
5. If API details or concrete patterns are needed, read `references/api.md` and `references/examples.md`.
6. Edit `~/.letta/extensions/statusline.tsx`.
7. Summarize the absolute file path changed and tell the user to run `/reload` unless the command can reload automatically.

## Bare `/statusline` behavior

If the user ran `/statusline` without a specific request:

- If a custom statusline file exists, summarize what it appears to do and ask what they want to change.
- If no custom file exists, explain that Letta is using the built-in default statusline and offer focused next steps:
  1. start from the default Letta statusline
  2. add project info like git branch, worktree, or PR
  3. migrate an existing legacy statusline `.sh` file
  4. match shell prompt / PS1
  5. describe a custom statusline in their own words

Keep this conversational. Do not build a menu UI unless the product command explicitly asks for one.

## Rules

- Global-only for now. Do not create project extensions.
- Keep the extension single-file for MVP.
- Do not assume extra npm packages are available.
- Do not use relative multi-file imports yet.
- Keep renderers synchronous. Do not shell, fetch, or await inside render.
- Do async work in setup code, intervals, subscriptions, or status providers.
- Return a disposer that clears timers/subscriptions.
- Preserve existing extension code unless the user asks to reset.
- Do not delete legacy command statusline files or settings unless the user explicitly asks.

## Useful references

- `references/api.md` - extension API, render context, lifecycle rules
- `references/examples.md` - common statusline patterns
- `references/migration.md` - legacy command `.sh` and PS1 migration
