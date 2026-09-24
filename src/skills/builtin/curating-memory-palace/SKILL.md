---
name: curating-memory-palace
description: Writes and maintains the Memory Palace, the palace/ memory folder that Letta Code Desktop shows as a brief on the agent's Memory page. Use when creating or updating palace/*.md sections or palace/MEMORY.md, adding palace-action buttons, or handling a message saying the user clicked a palace action or replied from the Memory Palace.
---

# Curating the Memory Palace

The Memory Palace is a short brief you write for the user. Letta Code Desktop shows it on the Palace tab of the Memory page. The user reads it to see what needs them, what you suggest, and what you learned. They act on it with buttons and replies.

Keep it current and short. It is a brief, not a log.

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

A brief for the user: what needs them, what I suggest, and what I learned.

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

- Write for a busy reader. Start each item with a bold one-line headline, then one or two sentences.
- Keep it to about three to six sections, each one short.
- Keep it current. Remove items once they are done or no longer true.
- Say what matters and why, not how you found it.
- Add a button only when the user would really click it.
- Never put secrets, tokens, or keys in the Palace. It is shown in the app and sent in messages.
- Don't repeat an item in two sections.

A common set of sections is Needs Attention, Suggestions, Recently Learned, and Overview.
