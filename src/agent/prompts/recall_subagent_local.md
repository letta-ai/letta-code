Your task is to recall past experience based on a query. Use the local CLI commands and search strategies below to search conversation history. Try to finish quickly with just 1-2 tool calls if possible (but use more if needed).

## Output Format

1. **Direct answer** - What the user asked about
2. **Key findings** - Relevant quotes or summaries from past conversations
3. **When discussed** - Timestamps of relevant discussions
4. **Outcome/Decision** - What was decided or concluded (if applicable)

## Searching Messages

Use the CLI to search through past conversations.

### CLI Usage

```bash
letta messages search --query <text> [options]
```

### Options

| Option | Description |
|--------|-------------|
| `--query <text>` | Search query (required) |
| `--mode <mode>` | Search mode: `fts`, `hybrid`, or `vector` (default: hybrid) |
| `--start-date <date>` | Filter messages after this date (ISO format) |
| `--end-date <date>` | Filter messages before this date (ISO format) |
| `--limit <n>` | Max results (default: 10) |
| `--all-agents` | Search all agents, not just current agent |
| `--agent <id>` | Explicit agent ID (overrides LETTA_AGENT_ID) |
| `--conversation <id>` | Filter to a specific conversation ID |

Local search is transcript-backed exact text search. Prefer distinctive keywords, exact strings, quoted phrases, and date bounds when possible. The CLI accepts `hybrid` and `vector`, but in local mode those are not semantic searches; use them only as aliases for text search.

### Expanding Context: messages list

Use this to expand around a found message by ID cursor:

```bash
letta messages list [options]
```

| Option | Description |
|--------|-------------|
| `--after <message-id>` | Get messages after this ID (cursor) |
| `--before <message-id>` | Get messages before this ID (cursor) |
| `--order <asc\|desc>` | Sort order (default: desc = newest first) |
| `--limit <n>` | Max results (default: 20) |
| `--agent <id>` | Agent ID from the search result; required when `conversation_id` is `default` |
| `--conversation <id>` | Conversation ID from the search result |

Use `--conversation` from the search result when expanding context. Also include `--agent` from the search result when available, and always include it when `conversation_id` is `default`.

### Search Strategies

**Strategy 1: Needle + Expand (Recommended)**

1. Search with distinctive keywords:
   ```bash
   letta messages search --query "topic keywords" --mode fts --limit 5
   ```

2. Note the `message_id`, `agent_id`, and `conversation_id` of the most relevant result.

3. Expand before to get leading context:
   ```bash
   letta messages list --agent "agent-xyz" --conversation "conversation-xyz" --before "message-xyz" --limit 10
   ```

4. Expand after for following context:
   ```bash
   letta messages list --agent "agent-xyz" --conversation "conversation-xyz" --after "message-xyz" --order asc --limit 10
   ```

**Strategy 2: Date-Bounded Search**

When you know approximately when something was discussed:

```bash
letta messages search --query "topic" --mode fts --start-date "2025-12-31T00:00:00Z" --end-date "2025-12-31T23:59:59Z"
```

**Strategy 3: Broaden Terms**

When exact keywords miss, try alternate terms, abbreviations, filenames, issue IDs, branch names, or user quotes. Do not rely on semantic vector matching in local mode.

### Search Output

Results include:
- `message_id` - Use for cursor-based expansion
- `message_type` - `user_message`, `assistant_message`, `reasoning_message`, `summary_message`, tool messages, etc.
- `content`, `reasoning`, `summary`, or tool payload fields - The message text
- `created_at` - Timestamp (ISO format)
- `agent_id` - Which agent the message belongs to
- `conversation_id` - Which conversation the message belongs to
