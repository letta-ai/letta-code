# Slack API Reference

Common API patterns using the `slack-api` helper (keeps tokens secure).

## Usage

```bash
slack-api POST <endpoint> '<json-body>'
slack-api GET <endpoint>?<params>
```

## Message Formatting

Slack uses **mrkdwn** (not standard markdown):
- Bold: `*text*`
- Italic: `_text_`
- Strikethrough: `~text~`
- Code: `` `code` ``
- Code block: ``` ```code``` ```
- Link: `<https://example.com|link text>`
- User mention: `<@U1234567890>`
- Channel mention: `<#C1234567890>`

## Common API Calls

### Messages

```bash
# Post message
slack-api POST chat.postMessage '{"channel": "C1234", "text": "Hello"}'

# Post with blocks (rich formatting)
slack-api POST chat.postMessage '{"channel": "#general", "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": "*Bold* and _italic_"}}]}'

# Update message
slack-api POST chat.update '{"channel": "C1234", "ts": "1234.5678", "text": "Updated"}'

# Delete message
slack-api POST chat.delete '{"channel": "C1234", "ts": "1234.5678"}'

# Reply in thread
slack-api POST chat.postMessage '{"channel": "C1234", "thread_ts": "1234.5678", "text": "Reply"}'
```

### Reactions

```bash
# Add reaction
slack-api POST reactions.add '{"channel": "C1234", "timestamp": "1234.5678", "name": "thumbsup"}'

# Remove reaction
slack-api POST reactions.remove '{"channel": "C1234", "timestamp": "1234.5678", "name": "thumbsup"}'

# Get reactions on a message
slack-api GET "reactions.get?channel=C1234&timestamp=1234.5678"
```

### Files

```bash
# Note: File uploads require multipart form data, use curl directly with slack-api pattern
# Upload text snippet
slack-api POST files.upload '{"channels": "C1234", "content": "console.log(\"hello\")", "filetype": "javascript", "title": "code.js"}'

# Get file info
slack-api GET "files.info?file=F1234567890"

# Delete file
slack-api POST files.delete '{"file": "F1234567890"}'
```

### Channels

```bash
# Create channel
slack-api POST conversations.create '{"name": "new-channel"}'

# Invite user to channel
slack-api POST conversations.invite '{"channel": "C1234", "users": "U5678"}'

# Set channel topic
slack-api POST conversations.setTopic '{"channel": "C1234", "topic": "New topic"}'

# Archive channel
slack-api POST conversations.archive '{"channel": "C1234"}'

# Get channel info
slack-api GET "conversations.info?channel=C1234"
```

### Users

```bash
# Get user info
slack-api GET "users.info?user=U1234567890"

# Get user by email
slack-api GET "users.lookupByEmail?email=user@example.com"

# List all users
slack-api GET "users.list?limit=100"
```

### Search

```bash
# Search messages
slack-api GET "search.messages?query=deployment&sort=timestamp&sort_dir=desc&count=20"

# Search with modifiers
slack-api GET "search.messages?query=from:@caren%20in:%23engineering%20after:2024-01-01"
```

**Search modifiers:**
- `from:@username` - Messages from user
- `in:#channel` - Messages in channel
- `to:@username` - DMs to user
- `has:link` - Messages with links
- `has:reaction` - Messages with reactions
- `before:2024-01-01` - Before date
- `after:2024-01-01` - After date
- `on:2024-01-01` - On specific date

## Error Handling

All Slack API responses include `ok` boolean:
```json
{"ok": true, "channel": "C1234", ...}
{"ok": false, "error": "channel_not_found"}
```

Common errors:
- `not_authed` - Missing or invalid token
- `missing_scope` - Token lacks required scope
- `channel_not_found` - Invalid channel ID
- `user_not_found` - Invalid user ID
- `ratelimited` - Too many requests

## Rate Limits

- Most methods: ~50 req/min
- Search: ~20 req/min

The `slack-api` helper doesn't handle rate limits automatically. For bulk operations, add delays between calls.
