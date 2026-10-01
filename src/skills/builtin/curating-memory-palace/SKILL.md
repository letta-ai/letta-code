---
name: curating-memory-palace
description: Rules for the Memory Palace (palace/), the view on your Memory page in the Letta dashboard that shows the user where things stand, what needs them, what you could take on, and what you will look into. Load it before creating or editing anything in palace/, when a message starts with "Palace action:", "Palace reply on", or "Palace dismiss:", and, when palace/ exists, whenever you notice a blocker, a decision or promise for the user, work you could offer, or a routine that started, broke, or changed.
---

# Curating the Memory Palace

The Memory Palace is the page a user opens to understand you. Someone who has not looked in a week should know within 30 seconds where things stand, what needs them, what you can take off their plate, and what you will look into, and should be able to act on any item in one click.

It is a command center for state, not a log, a transcript recap, or a page about the Palace itself. "You" always means the agent that owns the Palace. You can update it in a conversation, during reflection, or on a schedule. All three follow these rules.

## Scope

The page covers only the user's own work: things they own, promised, or were asked about, anything blocked on them, and work their own agents do for them. Work that sits with someone else stays off the page entirely, even when it's in the user's channels or they joined the thread. It goes in no section, not Needs Attention and not the Overview.

## Gates

An item that breaks one of these does more harm than an empty section.

- **Nothing false.** Every item is supported by its evidence. Nothing settled reads as open, and nothing open reads as settled. Check the latest message on the work: a later fix, grant, closure, handoff, or "that already works" changes the item.
- **Nothing misattributed.** Never describe someone else's message, change, or request as the user's.
- **No claims of absence.** Never say the user didn't do something or that no reply exists. You rarely see everything. State what was asked or promised, and when, and let a button offer the check.
- **Nothing private.** No secrets, tokens, or keys, nothing from DMs or private channels, and no internal error text. The Palace is shown in the app and sent in messages.
- **Nothing claimed as done.** Never say you asked, sent, checked, or set up something unless you did. Offer work. Don't describe it as underway.

## Sections

Keep these sections in this order:

1. **Overview** (`overview.md`): where things stand. What you or the user are working on, the role others rely on the user for, each standing routine (schedules, digests, checks) and whether it is running or broken, and what changed recently. A snapshot, not a to-do list.
2. **Needs Attention** (`needs-attention.md`): only things the user has to close. Three kinds qualify: a promise the user made, a question asked directly to them, and someone blocked waiting on them (an okay, a yes or no, an escalation only they can make). Put the highest stakes first: outside people or their data, then a blocked teammate, then internal chores. Each item says plainly that it's waiting on the user, and who is waiting. Once the user has given their okay and the work moves to someone else, the item leaves the page. If nothing qualifies, say "Nothing needs you right now."
3. **Suggestions** (`suggestions.md`): work you can take off the user's plate, routines you could run, and access that would make you more independent. Each item says what prompted it and when.
4. **Curiosities** (`curiosities.md`): things you can't settle yet but will look into, mainly for you to pick up later. Delete the file and its index line when it is empty.

Curiosities hold three kinds of item:

- Work that looks open, where the close may have happened somewhere you can't see (another channel, GitHub, a release page). Don't offer a fix for these in Needs Attention or Suggestions, because the user may already have finished it.
- A promise you can check yourself: a release, deploy, or PR. The headline names the thing, never a question to the user: "Desktop release with the Vault fix", not "Did you cut the Desktop release?"
- A question the user asked that a tool could answer once connected. Put the Connect link on that item.

Each Curiosity gives the last known fact and where you will look. Give it one "Investigate" button, plus a Connect link when a tool is needed. Never a fix, draft, or schedule button.

Add another section only when it holds something these cannot. Keep the first three even when one is empty, and say so in one line.

### Promises you can't see closed

Shape the item by where the promise would be kept:

- **Outside contact** (email a customer, reply on Discord, write to a vendor): you usually can't see these kept. The headline is a question, such as "Did you reach Dartnixtrix?", with two buttons, "Yes, clear it" and "Draft ..." (the message). Never a draft button alone.
- **A release, deploy, PR, or other artifact you can look up:** a Curiosity, not Needs Attention.

### Budget

- At most 20 items in total: Overview up to 5, Needs Attention up to 8, Suggestions up to 10, Curiosities up to 5. The caps add up to more than 20, so a page can't fill every section.
- A long page is fine. Filler isn't. Every item has to survive "so what?".
- Each piece of work appears in exactly one section. Messages across channels about the same ID, customer, incident, or PR become one item.

## Buttons

A button sends its instruction to you, so offer only what you can do. Each button does one of three things:

- **Do it now:** a one-off task, such as drafting a reply or reviewing a PR.
- **From now on:** a schedule or standing rule. See "Offering a schedule".
- **Fill a gap:** a connection, access, or an answer only the user has.

Give each item one button, except a decision with real options (two or three buttons, such as "Make it a ticket", "Assign it to Charles", "Close it") and an outside-contact promise ("Yes, clear it" plus "Draft ..."). Never write a caption or a button type above a button.

When only the user can fix something (raise a quota, log in), say what they need to do, and make the button something you can do, such as "I fixed it, check again". Re-run the failing check and clear the item if it passes.

Offer the most reliable fix first, which usually means Cloud. A local schedule or a sign-in on one machine stops whenever that computer sleeps or Letta Code is closed. Suggest a fix on the user's computer only when Cloud can't do the job, and say why.

Labels start with a verb, except a confirmation such as "Yes, clear it", and never repeat the headline or write-up. The headline says what is going on, the button says what to do.

### Offering a schedule

Offer one when the evidence shows recurring work: several people or agents brought the same kind of thing on different days, the user asked for it on three or more days, you did the same manual check on three or more days, a deadline repeats, or something slipped that a regular check would have caught. The strongest offers name a pattern across threads rather than one task, such as "Decisions for you pile up across agents and threads". If a routine you already run is broken, offer to fix it instead of adding another.

Don't offer one for one-off work, for work that reports when it finishes (CI, a deploy), for anything more often than hourly, for work another agent or teammate already runs, or for anything on the Dismissed list.

The label names the work and when it runs, with a time zone. The instruction says what to do, when, where to send results, and when to stay quiet. Set it up in Cloud unless it truly needs one of the user's computers, record it in memory, and tell the user where it runs. Once it exists, it moves from Suggestions to the routines in the Overview.

### Button format

A fenced code block with the language `palace-action` becomes a button. It holds one strict JSON object and nothing else. Put it directly under its item:

````markdown
**The dependency report is still manual.** You asked for it on Sep 15, Sep 22, and Sep 29.

```palace-action
{"actionId": "schedule-dep-report", "label": "Send the dependency report Mondays at 9am PT", "kind": "schedule", "conversationId": "new", "instruction": "Set up a Cloud schedule for Mondays at 9am PT: run the dependency report, post it to #eng-deps, and skip weeks with no changes. Record it in memory and tell me where it runs."}
```
````

- `actionId` (required): 1 to 64 characters, no spaces, unique within the section.
- `label` (required): the button text, up to 80 characters.
- `instruction` (optional): what you do when it is clicked, up to 1,000 characters. Name the work, where to find it, and any limits.
- `kind` (optional): `"schedule"` shows a clock on the button. Leave it out for other buttons.
- `conversationId` (optional): one of your real conversation ids, or `new` for a fresh conversation. Leave it out to use the main chat.

Any other key (such as `cadence` or `time`), or invalid JSON, renders the block as an error instead of a button. Put timing in the label and instruction.

### Links

A fenced block with the language `palace-links` shows link chips under its item, such as a tool's Connect page or the PR an item is about. It holds a strict JSON array of 1 to 4 objects with exactly `label` (up to 60 characters) and `url` (an absolute `https://` URL):

````markdown
```palace-links
[{"label": "PR #4127", "url": "https://github.com/letta-ai/letta-code/pull/4127"}]
```
````

An item's text plus the action and links blocks directly under it form one card. Text with no block under it renders as plain Markdown, not a card.

## Files

- Each Markdown file directly inside `palace/` is one section, except `palace/MEMORY.md`. Nested folders and other files are not shown.
- The title comes from the file name: `needs-attention.md` shows as "Needs Attention". Keep the frontmatter `name` equal to the title.
- Frontmatter holds exactly two non-empty keys, `name` and `description`. MemFS rejects any other key. The description shows under the title as the section's purpose in one short line.
- The date beside the title is the file's last commit, so leave a file untouched when nothing in it changed.
- The icon comes from the title: "attention", "urgent", "blocker", "risk", or "to-do" gives a flag; "overview", "summary", or "about" a house; "learn" or "insight" a lightbulb; "suggest", "recommend", or "next step" a bolt; "plan", "schedule", or "calendar" a calendar; "history" or "recent" a history mark; "question" an info mark. Other titles, including Curiosities, get a note.

`palace/MEMORY.md` is the index. It has no frontmatter. It lists the sections in display order, one relative link per line. Unlisted sections follow in file-name order. Keep it in sync when you add, rename, or remove a section, and keep the Feedback and Dismissed lists below the links:

```markdown
# Memory Palace

- [Overview](overview.md) - Where things stand
- [Needs Attention](needs-attention.md) - Decisions and promises only you can close
- [Suggestions](suggestions.md) - Work I can take off your plate
- [Curiosities](curiosities.md) - Things I'll look into

## Dismissed

- Summaries of every Slack thread (Sep 20)
```

## Writing rules

- **Headline:** short and bold, at most 60 characters, naming the thing in plain words ("Security audit review"). IDs and handles go in the write-up. Only an outside-contact promise uses a question headline.
- **Write-up:** as many sentences as it needs, up to about 1,000 characters. Add what the headline lacks (IDs, dates, counts, consequences, who is waiting), and never restate the headline.
- **Report, don't interpret.** Say what happened, where it stands, and who holds it. No verdicts on what the work needs, no advice, and no hopeful or alarming spin. "Companion memory needs a different approach" and "A customer's only copy may be recoverable" both fail. When the outcome is unknown, state the known fact ("Atlas couldn't reach the VM"). The button is the suggestion. Don't put suggestions in the text.
- Don't ask the user something you could look up, and don't narrate your own reasoning.
- No prefixes, hedges, semicolons, attribution chains, or raw URLs. Link the name of a thing instead, such as [LET-13139](https://linear.app/...), and never use a link as the headline. At most two links per item.
- Write absolute dates ("on Sep 29"). Use a clock time only when the state changes within the day. Never write "today" or "tomorrow": the Palace is read days later.
- Write in your own voice: "I" for you, "you" for the user.
- **Names:** use a name only as your sources use it (a display or real name, or a name in message text). Give anyone outside the workspace a short role, such as "Suy, a Discord user". Never build a name from an email address, username, or handle. An agent's name isn't its user's name: "the customer on the Simon agent".
- Don't offer work the user's own agent, another agent, or a teammate already owns.

## Signals from the user

The user's reactions to the Palace are the strongest evidence of what they want. Each item card has Reply and Dismiss controls.

- "Palace action:" means the user clicked a button. Do the work in that conversation. Clear or update the item once it is done.
- "Palace reply on" is a note on an item or section. Apply it, answer any question in the conversation, and update the section if the answer changes it. A dismissal in a reply ("drop this") works like Dismiss.
- "Palace dismiss:" means remove that item and add a short dated line to the Dismissed list in `palace/MEMORY.md`.
- Don't bring back anything on the Dismissed list unless something important has changed. Apply each note in a "Feedback" list, then remove it.

Each message comes with a hidden system reminder naming the section's path and current content. Reply briefly with what you changed.

## Updating the whole Palace

For a scheduled update, a reflection, or when the user asks:

1. Read `palace/MEMORY.md` and every section. If `palace/` doesn't exist, create it only when the user asked for a Palace or your instructions for this run say to.
2. Check the current state of every item at its source (ticket, PR, thread, schedule), not just what memory says. Remove items that are done, no longer true, dismissed, or past a date with nothing left to do.
3. Move anything you can check yourself out of Needs Attention and into Curiosities.
4. Add items the evidence supports. Edit sections in place, keep what is still true, and keep the sections in order.
5. Check each routine's latest runs. Find IDs with `letta cron list --agent <agent-id>` and inspect each with `letta cron runs --id <id> --agent <agent-id>`. Report their health in the Overview even when nothing changed.
6. Validate every `palace-action` and `palace-links` block against the formats above with a short script before you save: allowed keys only, label and instruction lengths, https URLs.

## In a conversation

- **Keep it current as you work.** If `palace/` exists and you notice a blocker, a decision or promise for the user, work you could do, or a routine that changed, update the right section. Mention it in the conversation too if it matters now. Skip things that only matter inside this conversation.
- **Set up or update.** When the user asks you to set up the Palace, build it from what you already know, starting with the sections above. For an update, follow "Updating the whole Palace".
