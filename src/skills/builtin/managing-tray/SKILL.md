---
name: managing-tray
description: Add, update, list, and remove user-visible Tray items for the current Letta Cloud conversation. Use when durable, glanceable session content would help the user follow or guide ongoing work.
---

# Managing Tray

Tray is a small, user-visible workspace for important content from the current
work session. Use it for durable, glanceable content such as a table of open
pull requests, a Linear ticket summary, a checklist, or current decision notes.

Do not use Tray for ordinary chat replies, transient progress, hidden state, or
secrets. Update an existing item when replacing the same content instead of
creating duplicates. A conversation can contain at most 15 items.

Tray is available only for Letta Cloud agents.

## Markdownlet payload

The initial payload type is a versioned markdownlet:

```json
{
  "version": 1,
  "type": "markdownlet",
  "title": "Open pull requests",
  "markdown": "| PR | Status |\n| --- | --- |\n| #123 | CI running |"
}
```

- `version` must be `1`.
- `type` must be `markdownlet`.
- `title` is required and limited to 120 characters.
- `markdown` is standard Markdown with GFM tables.

## Commands

Use the active agent and conversation IDs explicitly. Replace `AGENT_ID`,
`CONVERSATION_ID`, and `TRAY_ITEM_ID` below with their actual values. For add
and update, write the payload to `tray-item.json` first. These one-line commands
work in POSIX shells, PowerShell, and cmd.exe.

```text
letta tray add --agent AGENT_ID --conversation-id CONVERSATION_ID --tray-payload-file tray-item.json
letta tray list --agent AGENT_ID --conversation-id CONVERSATION_ID
letta tray update TRAY_ITEM_ID --agent AGENT_ID --conversation-id CONVERSATION_ID --tray-payload-file tray-item.json
letta tray delete TRAY_ITEM_ID --agent AGENT_ID --conversation-id CONVERSATION_ID
```

After adding or updating an item, list the Tray to verify the saved state and
retain the returned item ID for future updates or deletion. Remove the temporary
payload file after the command succeeds.
