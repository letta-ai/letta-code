# MessageChannel

Send a message or channel action to an external channel in response to a channel notification.

When you receive a `<channel-notification>`, use this tool to reply directly to the user on the same external channel. A normal assistant response is not delivered back to the external channel automatically.

Preferred pattern:
- `action="send"` to send a normal reply
- `channel` + `chat_id` from the notification attributes
- `message` for the text body

Parameters:
- `action`: The action to perform. The exact available actions depend on the active channel plugins and are reflected in the JSON schema.
- `channel`: The platform to send to (matches the `source` attribute)
- `chat_id`: The chat ID to send to (matches the `chat_id` attribute)
- `message`: The text to send for `action="send"`
- `replyTo`: (Optional) Reply to a specific message ID. Omit this unless you intentionally want the platform's quote/reply UI.
- `messageId`: (Optional) Target message id for message-scoped actions like reactions.
- `emoji`: (Optional) Reaction payload for channels that support reactions.
- `remove`: (Optional) Set to `true` to remove the reaction instead of adding it
- `media`: (Optional) Absolute local file path for file/media uploads on channels that support uploads.
- `filename`: (Optional) Override the uploaded filename when supported by the channel.
- `title`: (Optional) Override the uploaded attachment title when supported by the channel.

Rules:
- Always pass `action` explicitly, even for a normal reply.
- `react` should be its own call.
- `upload-file` can include both `media` and `message` so the uploaded file has a caption/comment when the channel supports it.
