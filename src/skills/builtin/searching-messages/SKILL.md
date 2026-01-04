---
name: searching-messages
description: Search past messages to recall context. Use when you need to remember previous discussions, find specific topics mentioned before, pull up context from earlier in the conversation history, or find which agent discussed a topic.
---

# Searching Messages

This skill helps you search through past conversations to recall context that may have fallen out of your context window.

## When to Use This Skill

- User asks "do you remember when we discussed X?"
- You need context from an earlier conversation
- User references something from the past that you don't have in context
- You want to verify what was said before about a topic
- You need to find which agent discussed a specific topic (use with `finding-agents` skill)

## Script Usage

```bash
npx ts-node scripts/search-messages.ts --query <text> [options]
```

### Options

| Option | Description |
|--------|-------------|
| `--query <text>` | Search query (required) |
| `--mode <mode>` | Search mode: `vector`, `fts`, `hybrid` (default: hybrid) |
| `--start-date <date>` | Filter messages after this date (ISO format) |
| `--end-date <date>` | Filter messages before this date (ISO format) |
| `--limit <n>` | Max results (default: 10) |
| `--all-agents` | Search all agents, not just current agent |
| `--agent-id <id>` | Explicit agent ID (for manual testing) |

### Search Modes

- **hybrid** (default): Combines vector similarity + full-text search with RRF scoring
- **vector**: Semantic similarity search (good for conceptual matches)
- **fts**: Full-text search (good for exact phrases)

## Companion Script: get-messages.ts

Use this to expand around a found needle by message ID cursor:

```bash
npx ts-node scripts/get-messages.ts [options]
```

| Option | Description |
|--------|-------------|
| `--after <message-id>` | Get messages after this ID (cursor) |
| `--before <message-id>` | Get messages before this ID (cursor) |
| `--order <asc\|desc>` | Sort order (default: desc = newest first) |
| `--limit <n>` | Max results (default: 20) |
| `--agent-id <id>` | Explicit agent ID |

## Search Strategies

### Strategy 1: Needle + Expand (Recommended)

Use when you need full conversation context around a specific topic:

1. **Find the needle** - Search with keywords to discover relevant messages:
   ```bash
   search-messages.ts --query "flicker inline approval" --limit 5
   ```

2. **Note the message_id** - Find the most relevant result and copy its `message_id`

3. **Expand before** - Get messages leading up to the needle:
   ```bash
   get-messages.ts --before "message-xyz" --limit 10
   ```

4. **Expand after** - Get messages following the needle (use `--order asc` for chronological):
   ```bash
   get-messages.ts --after "message-xyz" --order asc --limit 10
   ```

### Strategy 2: Date-Bounded Search

Use when you know approximately when something was discussed:

```bash
search-messages.ts --query "topic" --start-date "2025-12-31T00:00:00Z" --end-date "2025-12-31T23:59:59Z" --limit 15
```

Results are sorted by relevance within the date window.

### Strategy 3: Broad Discovery

Use when you're not sure what you're looking for:

```bash
search-messages.ts --query "vague topic" --mode vector --limit 10
```

Vector mode finds semantically similar messages even without exact keyword matches.

### Strategy 4: Find Which Agent Discussed Something

Use with `--all-agents` to search across all agents and identify which one discussed a topic:

```bash
search-messages.ts --query "authentication refactor" --all-agents --limit 10
```

Results include `agent_id` for each message. Use this to:
1. Find the agent that worked on a specific feature
2. Identify the right agent to ask follow-up questions
3. Cross-reference with the `finding-agents` skill to get agent details

**Tip:** Load both `searching-messages` and `finding-agents` skills together when you need to find and identify agents by topic.

## Search Output

Returns search results with:
- `message_id` - Use this for cursor-based expansion
- `message_type` - `user_message`, `assistant_message`, `reasoning_message`
- `content` or `reasoning` - The actual message text
- `created_at` - When the message was sent (ISO format)
- `agent_id` - Which agent the message belongs to
