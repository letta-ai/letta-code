# Exploring Letta Conversation History

This guide covers how to search and learn from an agent's own past conversations stored on the Letta server. This is useful during `/init` to discover context from earlier sessions — decisions made, preferences expressed, project knowledge accumulated.

## When to Use

- During init to bootstrap memory from past conversations with this user
- When the user says "you should already know this" or references past discussions
- To recover context after memory was reset or reorganized

## How It Works

Letta agents have a full message history stored server-side. Even after messages leave the context window (via compaction/summarization), they remain searchable.

### Using the Recall Subagent

The `recall` subagent (`subagent_type: "recall"`) searches past conversation history:

```
Task({
  subagent_type: "recall",
  description: "Search past discussions",
  prompt: "Search conversation history for discussions about [topic]. Summarize key decisions, preferences, and context found."
})
```

Use this to find:
- **User preferences** expressed in past sessions ("I prefer...", "don't do...", "always...")
- **Project decisions** ("we decided to...", "the reason we chose...")
- **Debugging context** ("the bug was caused by...", "we fixed this by...")
- **Workflow patterns** (how the user typically works, what they ask for)

### Parallel Recall for Broad Discovery

For deep init, launch multiple recall searches in parallel to cover different topics:

```
// Launch all in a single message
Task({ subagent_type: "recall", description: "Find user preferences", prompt: "Search for user preferences, rules, and style guidelines..." })
Task({ subagent_type: "recall", description: "Find project decisions", prompt: "Search for architectural decisions and technical choices..." })
Task({ subagent_type: "recall", description: "Find gotchas", prompt: "Search for bugs, gotchas, warnings, and things to watch out for..." })
```

### Tips

- Recall searches the raw message history — it finds exact phrases and topics
- Results may include outdated information; cross-reference with current code state
- Distill findings into memory files — don't just copy raw conversation snippets
- Focus on **durable knowledge** (preferences, conventions, architecture) not transient details (specific commits, temporary debugging notes)

## Letta History vs Claude Code/Codex History

| Source | What it contains | When to use |
|--------|-----------------|-------------|
| **Letta history** | Past conversations with this agent | Always available; primary source for this agent's accumulated knowledge |
| **Claude Code** (`~/.claude/`) | Sessions from Claude Code CLI | When migrating from Claude Code; contains user prompts and assistant responses |
| **Codex** (`~/.codex/`) | Sessions from OpenAI Codex CLI | When migrating from Codex; contains user prompts and tool usage |

For Claude Code/Codex analysis, see [[reference/claude_and_codex_history.md]].
