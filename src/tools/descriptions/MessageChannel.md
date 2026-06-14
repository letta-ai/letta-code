# MessageChannel

Send a message or channel action to an external channel.

When you receive a `<channel-notification>`, use this tool to reply directly to the user on the same external channel. A normal assistant response is not delivered back to the external channel automatically.

There are two supported send modes:
- Reply mode: use `channel` + `chat_id` from the notification to respond in the current routed chat.
- Proactive mode: use `channel` + `target` on supported channels to send to an explicit outbound destination.

Preferred reply pattern:
- `action="send"` to send a normal reply
- `channel` + `chat_id` from the notification attributes
- `message` for the text body

Parameters:
- `action`: The action to perform. The exact available actions depend on the active channel plugins and are reflected in the JSON schema.
- `channel`: The platform to send to.
- `chat_id`: Reply target for the current routed chat. Use this when responding to a channel notification.
- `target`: Explicit outbound target for proactive sends on supported channels.
- `accountId`: Optional channel account selector when multiple eligible accounts are available.
- `message`: Text body for `action="send"`.
- `replyTo`: Optional message ID to reply to. Omit this unless you intentionally want the platform's quote/reply UI.
- `messageId`: Optional target message id for message-scoped actions like reactions.
- `emoji`: Optional reaction payload for channels that support reactions.
- `remove`: Optional boolean to remove a reaction instead of adding it.
- `media`: Optional absolute local file path for file/media uploads on channels that support uploads.
- `filename`: Optional uploaded filename override when supported by the channel.
- `title`: Optional uploaded attachment title when supported by the channel.

Rules:
- Always pass `action` explicitly, even for a normal reply.
- Pass exactly one of `chat_id` or `target`.
- `react` should be its own call.
- `upload-file` can include both `media` and `message` so the uploaded file has a caption/comment when the channel supports it.
- Telegram supports `action="send-rich"` for Bot API Rich Messages from Markdown content. Use it for headings, lists, tables, rich block quotes, details blocks, formulas, and longer structured messages; use `upload-file` for local media files.

Telegram rich messages:
- In Telegram private chats, normal `action="send"` messages are sent through Bot API Rich Messages by default when the Telegram account enables `rich_private_chat_default`; with that setting disabled, use explicit `action="send-rich"` for rich delivery.
- Use `action="send-rich"` with `channel="telegram"` for structured Markdown rendered by Telegram Bot API Rich Messages.
- Use this when the output benefits from real headings, tables, block quotes, collapsible details, footnotes, task lists, or formulas.
- The `message` field is passed as Telegram rich Markdown. Supported examples include:
  - headings: `# Heading`, `## Heading`
  - lists: `- item`, `1. item`, `- [ ] task`, `- [x] done`
  - tables: GitHub-style pipe tables
  - block quotes: `> quoted text`
  - collapsible details: `<details><summary>Title</summary>content</details>`
  - inline math: `$E = mc^2$`
  - display math: `$$E = mc^2$$` or fenced `math` code blocks
  - footnotes: `text[^id]` with `[^id]: definition`
- Prefer dollar-delimited math. `\(...\)` and `\[...\]` do not reliably render as formulas in Telegram rich Markdown.
- Do not use `send-rich` for local file uploads. Use `upload-file`; rich Markdown media blocks only support HTTP/HTTPS URLs.
- Rich messages persist only when the final `send-rich` call executes. If Telegram draft streaming is enabled for the account, the channel runtime may show ephemeral previews automatically; do not try to manage draft lifecycle from the tool call.
