---
name: slack
description: Search messages, read threads, and send messages in Slack. Use when looking up discussions, finding context about a topic, or sending notifications to channels.
---

# Slack

Search and interact with Slack workspaces from the command line.

## Important: Token Security

**NEVER include `$SLACK_TOKEN` directly in curl commands.** The token will be logged and exposed.

Always use the wrapper scripts which read the token from the environment internally:
- `slack send` - not `curl ... -H "Authorization: Bearer $SLACK_TOKEN"`
- `slack-api POST ...` - for advanced API calls

## Quick Setup (New Users)

```bash
# Add scripts to PATH
export PATH="$PATH:$HOME/.letta/skills/slack/scripts"

# Create Slack app with one click (opens browser)
slack-setup
```

This opens Slack's app creation page with all permissions pre-configured. Then:
1. Click **Create** to create the app
2. Go to **OAuth & Permissions** → **Install to Workspace**
3. Copy the **User OAuth Token** (`xoxp-...`) - NOT the bot token
4. Set it in your shell:
   ```bash
   export SLACK_TOKEN="xoxp-..."
   ```

**Why user token?** Bot tokens (`xoxb-`) cannot search messages (Slack limitation). User tokens can do everything bots can, plus search.

## Quick Setup (Existing Token)

```bash
export SLACK_TOKEN="xoxp-..."   # User token (recommended) or xoxb- bot token
export PATH="$PATH:$HOME/.letta/skills/slack/scripts"
```

## Commands

### Search messages

```bash
slack search "deployment failed"
slack search "from:@caren database"
slack search "in:#engineering api"
slack search "in:#engineering after:2024-01-01 bug"
```

Search supports Slack's modifiers: `from:`, `in:`, `to:`, `has:link`, `has:reaction`, `before:`, `after:`, `on:`.

### Send messages

```bash
slack send "#general" "Hello team!"
slack send "#alerts" ":rocket: Deployment complete"
slack send "@caren" "Quick question..."
```

### Join a channel

The bot must be a member of a channel to read its history. Join public channels with:

```bash
slack join "#engineering"
```

For private channels, someone must invite the bot manually via Slack.

### List channels

```bash
slack channels
```

### Read channel history

```bash
slack history "#engineering"
slack history "#engineering" 50    # Last 50 messages
```

### Read thread replies

```bash
slack thread "C1234567890" "1234567890.123456"
slack thread "C1234567890" "1234567890.123456" --json   # Raw JSON output
```

Thread timestamps (`ts`) come from search results or channel history.

### List and view users

```bash
slack users
slack user "U1234567890"
```

## Advanced: Direct API Access

For operations not covered by `slack`, use `slack-api` (keeps token secure):

```bash
# Post with rich formatting (blocks)
slack-api POST chat.postMessage '{"channel": "#general", "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": "*Bold* and _italic_"}}]}'

# Add reaction
slack-api POST reactions.add '{"channel": "C1234", "timestamp": "1234.5678", "name": "thumbsup"}'

# Get user info
slack-api GET "users.info?user=U1234567890"

# Reply to thread
slack-api POST chat.postMessage '{"channel": "C1234", "thread_ts": "1234.5678", "text": "Thread reply"}'
```

See [references/api.md](references/api.md) for more API patterns.

## Permissions Included

The manifest (`slack-setup`) includes these bot scopes:

| Category | Scopes |
|----------|--------|
| Search | `search:read` |
| Messaging | `chat:write`, `chat:write.public`, `reactions:read`, `reactions:write` |
| Public channels | `channels:read`, `channels:history`, `channels:join` |
| Private channels | `groups:read`, `groups:history` |
| Direct messages | `im:read`, `im:write`, `im:history` |
| Users | `users:read`, `users:read.email` |
| Files | `files:read`, `files:write` |
| Other | `emoji:read`, `links:read` |
