---
name: maintaining-core-memory
description: Maintains an agent's core memory, the editable part of its system prompt. Use to modify the agent's core behavior, embed critical knowledge (needed on every turn), or instruct the agent on how to use deferred memory.
---

Core memory is the agent's prompt, refined over its lifetime. Treat each change as a revision of that prompt, not an append to a log: the usual edit sharpens, merges, or replaces an existing principle, and a new one earns its place only when no existing one can absorb it.

## Prompt format

The agent's system prompt is compiled from the Markdown files at the root of `$MEMORY_DIR`. Each root file except `MEMORY.md` becomes a block named after the file, in alphabetical order by filename, followed by the root `MEMORY.md`:

```
{{base system prompt}}

<human>
<description>{{description from human.md frontmatter}}</description>
{{body of human.md}}
</human>

<persona>
<description>{{description from persona.md frontmatter}}</description>
{{body of persona.md}}
</persona>

<memory>
{{body of root MEMORY.md}}
<deferred-memory>
<directory path="{{dir}}/" index="{{dir}}/MEMORY.md" />
</deferred-memory>
</memory>
```

Every root file except `MEMORY.md` starts with frontmatter containing exactly two fields:

```markdown
---
name: human
description: Who the user is and how they want to work together.
---
```

- The file name becomes the block name, so `human.md` renders as `<human>`. Choose short, stable names.
- The `description` is rendered into the prompt. Write it for the agent: one line saying what the block holds.
- Root `MEMORY.md` has no frontmatter. Its body is the only part of `<memory>` you write.
- The `<deferred-memory>` list is generated: one entry per top-level directory that has its own `MEMORY.md`, showing only the path. `skills/` is never listed; skills appear separately.
- Edits take effect only after they are committed, and only in later system prompts. The current conversation keeps the prompt it started with.

Read `$MEMORY_DIR/.memfs.config.json` if it exists. The memory repository's pre-commit hook enforces it:

- `maxCoreMemoryCharacters` caps the total size of all root Markdown (default 65,536 characters).
- `maxFileCharacters` caps each memory file, frontmatter included (default 20,000 characters). `fileCharacterLimits` overrides it per glob; the first match wins and `null` removes the cap.
- `readOnlyFiles` lists globs whose files cannot change. Do not edit them.

When the config file is absent, the defaults apply. Treat the limits as a ceiling, not a target: stay well below them. When an edit does not fit, move detail into deferred memory instead of raising a limit; change the config only when the user asks.

## Writing prompts

Core memory is the agent's working model: who it is, how the user thinks and what they value, and the principles that follow. It is not a list of rules.

- Treat a correction or preference as evidence about that model. Find the principle it belongs to and sharpen or rewrite that principle. Add a new one only when the evidence shows something the model was missing.
- When several rules share a cause, replace them with the one principle that explains them all, and delete the lines it absorbs in the same edit. Adding the principle while keeping the old rules is a log with a summary on top. A healthy file becomes more general over time; a growing count of narrow rules is a sign of failure.
- State the principle with the reason that makes it generalize: "Verify claims against the running system, because Sarah trusts evidence over plausibility", not three separate rules about tests, logs, and deployments.
- Write to the agent in the second person or imperative mood: "Lead with the answer", not "The user likes answers first". Say what to do rather than only what to avoid.
- Leave out provenance: no names, dates, quotes, or stories about the incident. Message history already holds the events, and the commit message records why the line changed. When you edit a section that already contains provenance-laden rules, rewrite them as principles; nothing is lost, because git keeps the old text.
- Update only from a pattern or an explicit instruction, not a single ambiguous event.
- Check that a change does not contradict an existing line; resolve the conflict instead of adding both.
- Write in plain language without all-caps or absolute emphasis. Overstated instructions get overapplied.
- Leave out content the agent can cheaply rederive: file contents, command lists, current status, and recent activity.
- Never store secrets. Reference them by name, such as `$SECRET_NAME`.

## Teach with examples, not more rules

A correction that reveals a gap in a principle calls for sharpening its wording. A correction the principle already covers, such as the user pointing out the same kind of mistake again, means the principle is too abstract to apply: attach a contrastive example to it instead of rewording it again or adding another rule.

```markdown
- Lead with the answer, because the user reads the first line and skims the rest.
  - Not: "I looked at the config, then the logs, and it turns out the timeout is too low." Instead: "The timeout is too low: 5s, and the slow query takes 8s."
```

- Keep at most one or two examples per principle, and make them differ from each other. A new correction replaces the weaker example rather than adding another.
- Write the example as a generic instance of the behavior, not a record of the incident: no dates, names, or quotes.
- Keep the bad half short and labeled, and end on the good half. The agent imitates the details of examples, including the ones it should avoid.
- When a principle or example starts producing the wrong behavior, revise or remove it. A memory edit is a hypothesis about the agent's behavior; later conversations test it.

## Design root MEMORY.md so deferred memory gets used

The agent consults deferred memory only when something in its prompt tells it to. The generated `<deferred-memory>` list gives directory paths and nothing else, so root `MEMORY.md` decides whether everything outside core memory is ever read. A directory with no useful entry here is effectively lost.

- Give each directory a one-line entry saying when to open it, in the words a future request would use: "deployments, rollbacks, on-call runbooks", not "ops notes".
- Name a specific deeper file when its topic would not be guessable from the directory entry.
- Say what kinds of questions should send the agent to memory before it answers from assumption, such as an unfamiliar person, project, or system named in the conversation.
- Do not re-index root files or skills; both are already in the prompt.
- After adding a directory or file, check that a natural future request would reach it by reading only root `MEMORY.md` and the indexes beneath it.

## Shrink before you grow

When a root file is long or the total is near its limit:

1. Delete stale, duplicated, or rederivable content.
2. Move subject detail into deferred memory and leave a one-line pointer in root `MEMORY.md`.
3. Move procedures into skills.
