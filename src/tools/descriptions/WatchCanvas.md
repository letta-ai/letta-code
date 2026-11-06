Watch one Slack canvas in this conversation. Requires a Slack harness supporting canvas watches. Returns a background task; changes arrive as scoped task notifications. Stop it with TaskStop. Start at most one watch per canvas in a conversation.

The first detected edit after two quiet minutes produces an immediate, size-capped “editing started” event. Later edits coalesce into one net “editing settled” diff after 30 seconds without a change, or after two minutes of continuous editing. Edit events are limited to one per minute. Large diffs become compact summaries; use read_canvas for the current content. Comment-thread changes are rate-capped separately. The agent's own canvas writes do not echo.

Snapshots and pending edits persist in the harness. If the session restarts, call WatchCanvas again to resume from that snapshot. In managed Cloud sandboxes, the normal Monitor duration cap applies; re-arm the watch after its timeout notification.
