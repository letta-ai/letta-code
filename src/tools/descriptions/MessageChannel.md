# MessageChannel

Send a message to an external channel (Telegram, Slack, etc.) in response to a channel notification.

When you receive a `<channel-notification>`, use this tool if you want the external user to see your reply. A normal assistant response in Letta Code is not delivered back to Telegram/Slack/etc. Extract the `source` and `chat_id` from the notification attributes and pass them as `channel` and `chat_id`.

Parameters:
- `channel`: The platform to send to (matches the `source` attribute)
- `chat_id`: The chat ID to send to (matches the `chat_id` attribute)
- `text`: The message text to send
- `reply_to_message_id`: (Optional) Reply to a specific message by its `message_id`. Omit this unless you intentionally want the platform's quote/reply UI.
