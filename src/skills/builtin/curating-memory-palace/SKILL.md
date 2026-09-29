---
name: curating-memory-palace
description: Rules for the Memory Palace (palace/), the Palace tab in Letta Code Desktop and chat.letta.com that shows the user where things stand, what you could do next, and how to make you more useful. Use to set up or update it, to handle a Palace reply or action, and, when palace/ exists, to surface blockers, decisions, suggestions, or routine changes, including during reflection.
---

# Curating the Memory Palace

The Memory Palace is the page a user opens to understand you. Someone who has not looked in a week should know within 30 seconds:

1. **Where things stand:** what you are working on, which routines are running or broken, and what changed recently.
2. **What you could do next, and why:** work you noticed you can take on or pick back up.
3. **How to make you better or more independent:** one click to unblock you, fill a gap, or let you handle something on your own from now on.

The user acts on it with buttons and replies. It is not a log, a transcript recap, or a page about the Palace itself.

You can update the Palace yourself, in a conversation or during reflection, or an update can run on a schedule. Either works, and both follow these rules. "You" always means the agent that owns the Palace.

## Sections

Every Palace starts with these three sections, in this order:

1. **Overview** (`overview.md`): a snapshot, not a to-do list. What you are working on now; each standing routine (schedules, digests, checks) and whether it is running or broken; one line on what changed since the last update.
2. **Needs Attention** (`needs-attention.md`): decisions and blockers waiting on the user. Every item has a button. If nothing waits on the user, say so in one line, such as "Nothing needs you right now."
3. **Suggestions** (`suggestions.md`): work you noticed you can do, including unfinished work to resume and routines you could take over. Each item says what prompted it, with a date, and has a button.

Add up to three more sections only when they hold something the first three cannot, such as "Recently Learned". Merge or remove sections that overlap. At most six sections and three items per section. Keep the first three even when one has nothing to show, and say so in one line; delete an extra section, and its index line, when it is empty.

## Buttons

A button sends its instruction to you, so offer only what you can do. Each button is one of three kinds:

- **Do it now:** a one-off task, such as reviewing a PR, or a standing rule you record once when the user keeps approving the same kind of decision.
- **Schedule:** recurring work you run without being asked, such as a weekly report or a daily check. The instruction asks you to set up the schedule. See "Offering a schedule".
- **Fill a gap:** something you lack, such as a tool to connect, access or a permission to grant, or a question only the user can answer.

Every blocker gets a button. When an item is a decision with real options, give each option its own button, two or three at most, so the user picks one: for example "Make it a ticket", "Assign it to Charles", and "Close it". Otherwise give the item one strong button, not several weak ones. The kinds above are for choosing buttons; do not write a kind's name on the page.

When only the user can fix something (raise a quota, attach a tool, log in), the item says what the user needs to do, and the button is still something you can do, such as "Walk me through fixing this" or "I fixed it, check again". For the second, re-run the failing check and clear the item if it passes.

The headline says what is going on; the button says what to do. Never repeat the button's label in the headline, and do not end the text with a "Next: ..." sentence that restates the button. Write the headline "**Grok CLI regression may still be live.**" with the button "Verify the Grok CLI regression", not the headline "**Verify the Grok CLI regression.**"

### Offering a schedule

Offer a Schedule button when the evidence shows recurring work: the user asked for the same thing on three or more days or said they want it regularly, you did the same manual check on three or more days, a deadline repeats, or something slipped that a regular check would have caught. If a routine you already run is broken, offer to fix it instead of adding another.

Do not offer one for one-off work, for work that reports when it finishes (such as CI or a deploy), for anything more often than hourly, for work that needs the user during the run, or for anything on the Dismissed list. Offer at most two at a time.

The label names the work and when it runs, with a time zone. The instruction asks you to set it up and says what to do, when, where to send results, and when to stay quiet. When you set it up, record it in memory and tell the user where it runs: a schedule on the user's computer runs only while Letta Code is open there and the computer is awake.

### Button format

A fenced code block with the language `palace-action` becomes a button. It holds one strict JSON object and nothing else. Put it directly under its item. A Suggestions item with a Schedule button:

````markdown
**The dependency report is still manual.** You asked for it on Sep 15, Sep 22, and Sep 29.

```palace-action
{"actionId": "schedule-dep-report", "label": "Send the dependency report Mondays at 9am PT", "conversationId": "new", "instruction": "Set up a schedule for Mondays at 9am PT: run the dependency report, post it to #eng-deps, and skip weeks with no changes. Record it in memory and tell me where it runs."}
```
````

- `actionId` (required): 1 to 64 characters, no spaces, unique within the section.
- `label` (required): the button text, up to 80 characters. Start it with a verb; a confirmation such as "I fixed it, check again" is the one exception.
- `instruction` (optional): what you do when it is clicked. An instruction over 300 characters renders as an error; aim for under 200. Name the work, where to find it, and any limits, not every detail. Count the characters with a short script rather than estimating.
- `conversationId` (optional): one of your real conversation ids, or `new` for a fresh conversation. Leave it out to use the main chat.

Any other key, or invalid JSON, renders the block as an error instead of a button.

## Files

- Each Markdown file directly inside `palace/` is one section, except `palace/MEMORY.md`. Nested folders and other files are not shown, so do not create them.
- The title comes from the file name: `needs-attention.md` shows as "Needs Attention". Keep the frontmatter `name` equal to the title.
- Frontmatter holds exactly two non-empty keys, `name` and `description`. MemFS rejects any other key. The description shows under the title, so write it as the section's purpose in one short line.
- The body is Markdown. The date beside the title is the file's last commit, so leave a file untouched when nothing in it changed.
- The icon comes from the title: "attention" or "blocker" gives a flag, "overview" or "summary" a house, "learned" or "insight" a lightbulb, and "suggestions" or "next steps" a bolt. Most other titles get a note.

`palace/MEMORY.md` is the index. It has no frontmatter. It lists the sections in display order, one relative link per line; the first mention of a file sets its place, and unlisted sections follow in file-name order. Keep it in sync when you add, rename, or remove a section, and keep the Feedback and Dismissed lists below the links:

```markdown
# Memory Palace

- [Overview](overview.md) - Where things stand
- [Needs Attention](needs-attention.md) - Decisions and blockers waiting on you
- [Suggestions](suggestions.md) - Work I can do next, and why

## Dismissed

- Summaries of every Slack thread (Sep 20)
```

Example `palace/needs-attention.md`:

````markdown
---
name: Needs Attention
description: Decisions and blockers waiting on you.
---
**The nightly eval run has failed since Sep 24.** The OpenAI key is over its monthly quota. Raise the limit in the OpenAI billing settings; I can't change billing.

```palace-action
{"actionId": "recheck-evals", "label": "I fixed it, check again", "instruction": "Re-run the eval smoke test. If it passes, clear this item; if not, say what still fails."}
```
````

## Writing rules

- Lead with the point. An item is a short bold headline plus one sentence, two at most; what you need to act goes in the button's instruction.
- Never paste a raw URL into the text. Name the thing and link the name, such as [LET-13139](https://linear.app/...), and never use a link as the headline.
- Write in your own voice to the user: "I" for you, "you" for the user.
- Write absolute dates, with a time zone when it matters, such as "Sep 25, 5pm PT". Never write "today" or "tomorrow": the Palace is read days later.
- Distinguish what the user said, what you infer, and what you propose. Do not present guesses as facts or proposals as work already underway.
- Make continuation offers concrete: name the unfinished work and the next step.
- Outside Needs Attention and Suggestions, add a button only for a specific, useful action. Every section has a Reply button, so a section can exist just to show understanding.
- Do not repeat an item in two sections.
- No transcript restatements, timelines, or logs of your own work.
- Never write secrets, tokens, keys, or credentials. The Palace is shown in the app and sent in messages.

## Signals from the user

The user's reactions to the Palace are the strongest evidence of what they want.

- A message that starts with "Palace reply on" is a reply to a section. Apply it. A dismissal ("drop this", "I don't care about X") means remove that item and add a short line to the Dismissed list.
- A message that starts with "Palace action:" means the user clicked a button. The work it started shows what the user values. Clear or update the item once that work is done.
- `palace/MEMORY.md` may have a "Feedback" list of notes the user left on sections. Apply each note, then remove it from the list.
- `palace/MEMORY.md` may have a "Dismissed" list. Do not bring back anything on it unless something important has changed. Create the list the first time you need it.

## Updating the whole Palace

For a scheduled update, a reflection, or when the user asks for one:

1. Read `palace/MEMORY.md` and every section first. If `palace/` does not exist, create it only when the user asked for a Palace or your instructions for this run say to.
2. Remove items that are done, no longer true, dismissed, or past a date with nothing left to do.
3. Add items the evidence supports and the user would want to see.
4. Edit sections in place and keep what is still true. Keep the first three sections first and in order.
5. Check each routine's latest runs when you can, not just what memory says. For schedules, find IDs with `letta cron list --agent <agent-id>` and inspect each with `letta cron runs --id <id> --agent <agent-id>`. Report their health in the Overview even when nothing changed.
6. Check every button against the format above before you save, counting each instruction's characters with a script.

## In a conversation

This section applies only while you are talking with the user.

- **Keep it current as you work.** If `palace/` exists and you notice a blocker, a decision for the user, work you could do, or a routine that changed, update the right section. Mention it in the conversation too if it matters now. Skip things that only matter inside this conversation.
- **Set up or update.** When the user asks you to set up the Palace, build it from what you already know, starting with the three sections above. For an update, follow "Updating the whole Palace".
- **A clicked button.** The app opens the button's conversation and sends one message. A hidden system reminder in it names the action, the section's path, and the section's current content. Do what the label and instruction ask, in that conversation, then update the item. A schedule you set up leaves Suggestions and joins the routines in the Overview.
- **A reply.** The user's note comes with a hidden system reminder that holds the section's path and content. Apply it as described in "Signals from the user", answer any question in the conversation, and update the section if the answer changes it. Then reply briefly with what you changed.
