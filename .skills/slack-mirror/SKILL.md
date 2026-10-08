---
name: slack-mirror
description: How to read a local Slack workspace mirror (the workspace export this project's agents consume, pointed to by $SLACK_WORKSPACE_DIR). Use when you must locate or parse channels, DMs, threads, or messages and resolve author identities from the export rather than querying the live Slack API.
metadata:
  status: proposed
  confidence: medium
  evidence: '["letta:conv-0e5976ac-ec7f-4cbd-816e-2ebdce32028f"]'
  rationale: 'Team agents repeatedly read the local Slack export to operate on this project, and the mirror layout plus identity caveats are non-obvious and documented nowhere in the repository. Capturing them as a project skill stops agents from re-probing real mirror files and re-deriving the agent-vs-bot resolution rules on every use.'
---

# Slack Workspace Mirror

`$SLACK_WORKSPACE_DIR` points to a local copy of a Slack workspace export that
this project's agents read. Do not assume it is the live Slack API; read the
mirror files directly.

## Layout

```
users.jsonl                         # every workspace account, one per line
channels/
  <channel ID>/                     # C… for a channel, D… for a DM
    metadata.json                   # the channel/DM's name, purpose, members
    <YYYY-MM-DD>/                   # UTC day the message (or thread root) was posted
      messages.jsonl                # that day's top-level messages, one per line
      threads/
        <root-ts>.jsonl             # one thread: root message, then its replies
```

- The folder under `channels/` is the channel ID, not its name; read
  `metadata.json` for the readable name.
- Messages are grouped by UTC day. A thread file lives under the day its root
  was posted, even when the replies came on later days.
- `messages.jsonl` holds only top-level messages. Replies appear only in the
  thread file (`threads/<root-ts>.jsonl`), never in `messages.jsonl`. A message
  that started a thread carries a `reply_count`.
- A DM's `metadata.json` has `"is_im": true` and a `user` field (the other
  party's ID) instead of a `name`.

## Resolving authors

- Resolve a message's `user` (`U…`) ID against `users.jsonl`, which lists every
  account — people, bots, and deactivated accounts (deleted accounts remain
  listed with `"deleted": true`).
- `is_bot: true` does NOT separate AI agents from integrations (GitHub, Linear,
  Sentry, …). Agents converse, take requests, and reply in threads;
  integrations post notifications. Classify senders by that behavior.
- When an agent or bot posts, the message's `user` is the account's `U…` ID and
  `bot_id` matches that account's `profile.bot_id`.
- `users.jsonl` does not list every author. People from other companies in
  shared channels appear only as message authors, and some bots post with only
  a `bot_id` (and a name in `bot_profile`/`username`) with no user entry. Treat
  an unresolvable `user` or `bot_id` as an external author rather than an error.

## Why this works / why it will be useful again

The mirror layout and its identity gaps were established by probing real export
files: field names, DM shape, thread placement, and which senders are absent
from `users.jsonl`. None of that is derivable from the repository or the live
API, so an agent that starts from this skill converges on correct parsing and
author resolution without re-running an empirical survey of the mirror.
