---
name: curating-memory-palace
description: Curates the Memory Palace, a user-facing command center for agent state in palace/. Use when creating or updating palace/*.md sections or palace/MEMORY.md, adding palace-action buttons, or handling a Palace action or reply.
---

# Curating the Memory Palace

Treat the Memory Palace as a command center for state: make your ongoing understanding, commitments, and possibilities legible to the user, and let them influence it through actions and replies. Desktop shows it on the Palace tab of the Memory page.

Choose contents that fit the agent and its relationship with the user. A companion might share relational understanding, shared interests, or unresolved questions. A work agent might surface pending work, proactively identified issues, or tasks it can resume. Neither is the universal template.

Show meaningful current state, not a transcript recap or a page about maintaining the Palace itself. Keep it concise without forcing everything into a task list.

## Files

The Palace is the `palace/` folder in your memory.

- Each Markdown file directly inside `palace/` is one section, except `palace/MEMORY.md`. Nested folders and other files are not shown.
- The section title comes from the file name: `needs-attention.md` shows as "Needs Attention". Pick file names that read well as titles, and keep `name` the same as the title.
- Frontmatter holds exactly `name` and `description`, like every memory file. MemFS rejects any other key. The description shows under the title, so write it as the section's purpose in one short line.
- The body is Markdown. The date beside the title is the file's last commit.

Example `palace/needs-attention.md`:

````markdown
---
name: Needs Attention
description: Decisions and follow-ups that need the user.
---
**The staging deploy is blocked on a secret.** `SLACK_SIGNING_SECRET` is not in 1Password yet, so the Atlantis plan fails.

```palace-action
{"actionId": "add-secret", "label": "Walk me through adding it", "instruction": "List the exact 1Password and Terraform steps"}
```
````

## Order

`palace/MEMORY.md` is the folder's index, and it sets the order. List the sections in the order you want them shown. Relative links such as `[Overview](overview.md)` work, and so do `./overview.md` and `palace/overview.md`. The first mention of a file decides its place. Sections you leave out come after, in file-name order.

Like every `MEMORY.md`, it has no frontmatter:

```markdown
# Memory Palace

State worth understanding, discussing, or acting on. Choose sections for this user; these are examples, not required categories.

- [Needs Attention](needs-attention.md) - Decisions and follow-ups that need the user
- [Suggestions](suggestions.md) - Next steps worth taking
- [Recently Learned](recently-learned.md) - What changed in my understanding
- [Overview](overview.md) - Who I am and what I am working on
```

## Icons

Each section gets an icon picked from its title. Titles with "attention" or "blocker" get a flag, "overview" or "summary" a house, "learned" or "insight" a lightbulb, and "suggestions" or "next steps" a bolt. Other titles get a note icon.

## Action buttons

A `palace-action` code block becomes a button. It holds one strict JSON object:

```palace-action
{"actionId": "review-pr", "label": "Review the PR", "conversationId": "new", "instruction": "Review PR 123 and list the blocking issues"}
```

- `actionId` (required): 1 to 64 characters, no spaces. Unique within the section.
- `label` (required): the button text, up to 80 characters. Start it with a verb.
- `instruction` (optional): what you should do when it is clicked, up to 300 characters.
- `conversationId` (optional): one of your conversation ids, or `new` for a fresh conversation. Leave it out to use the main chat.

Any other key, or invalid JSON, shows the block as code with an error instead of a button. Action blocks next to each other share one row.

When the user clicks a button, Desktop opens the target conversation and sends you one message. A hidden system reminder in it names the action, the section's path, and the section's current content. Do what the label and instruction ask, in that conversation.

## Replies

Every section has a Reply button. The user's note arrives in the main chat, or in the conversation named by the section's first action. A hidden system reminder in the message holds the section's path and content. Treat the note as feedback on that section:

- **Dismissal** ("drop this", "I don't care about X"): remove that item from the file. If the section is then empty, say so in one line, such as "Nothing needs you right now.", or delete the file and its index line. Don't bring the item back unless something important changes. Note the preference in memory so later updates don't add it again.
- **Correction**: fix the section.
- **Question**: answer in the conversation, and update the section if the answer changes it.

Then reply briefly with what you changed.

## Writing a good Palace

- Let sections reflect what matters in this relationship. Do not fill a fixed template or invent content to reach a section count.
- Lead with the point and enough context to understand it. Prefer short sections; use headlines where they help scanning.
- Keep state current. Remove stale items and empty categories unless their absence is itself useful information.
- Distinguish what the user told you, what you infer, and what you propose. Do not present interpretations as facts or possible work as already underway.
- Make continuation offers concrete: name the unfinished work and the next step, not just "I can continue."
- Add a button only for a useful, specific action. Understanding or correcting your state can be the whole purpose of a section; Reply is enough.
- Never put secrets, tokens, or keys in the Palace. It is shown in the app and sent in messages.
- Don't repeat an item in two sections.
