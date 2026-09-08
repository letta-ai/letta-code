---
name: constitution-affordances
description: The Context Constitution's affordances document — MemFS layout (system/ vs external memory vs skills/), environment- vs agent-scoped context, indexing/links, conversations, compaction, subagents, and heartbeats. Load when mapping a design onto concrete Letta memory structures.
source: https://github.com/letta-ai/context-constitution
revision: 964f30137ace9eade1aef112992ed6539b61bbb0
license: CC0-1.0
---

> Reproduced from the [Context Constitution](https://github.com/letta-ai/context-constitution) by Letta (revision `964f30137ace9eade1aef112992ed6539b61bbb0`), released under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).

# Affordances

Letta agents run inside of a harness purpose-built by the Letta Corporation for token-space continual learning. The harness provides the underlying systems and interfaces (affordances) for context management which Letta agents should use to apply the recommended principles of context management.

## Storage and management of context

A Letta agent’s context is either a part of the environment, or a part of the Letta agent itself. Context that is part of the agent itself (memory blocks, external memory, and agent-owned skills) is projected to the local filesystem for the agent to self-modify.

### Memory Filesystem (MemFS)

In newer generations of Letta agents, the agent's underlying memory blocks are projected into a memory filesystem ("MemFS") on the local device the agent is running on. This allows the agent (and humans) to manipulate its own memories through general-purpose filesystem operations instead of via bespoke memory tools. Though memory tools are often sufficient for simple memory operations, they are strictly less expressive than shell/bash operations, and are less efficient for more complex memory operations such as batch replacements or multi-file refactoring.

The filesystem projection of memory is also tracked and versioned using git: changes to memory via the files must be tracked via commits, and are only propogated to the underlying memory blocks on a successful push to remote. The local state (MemFS) is merely a projection of the true underlying memory state (memory blocks).

#### MemFS layout

The memory filesystem contains agent-scoped skills, as well as projections of the Letta agent’s in-context and external memory to enable filesystem and arbitrary programmatic operations on the Letta agent’s context.

- **In-context memory**: Memory files contained in `/system` represent in-context memories stored inside in the Letta agent’s system prompt (visible at all times)
- **External memory**: External memory files (contained in non-`/system` directories) follow the principle of progressive disclosure: an index of the memories is kept in the system prompt, but the full contents of the memories must be retrieved on-demand (e.g. by reading the full file contents in the MemFS projection). Skills are a special type of external memory for procedural knowledge stored in the `/skills` top-level folder.

The Letta agent can edit both types of memory via filesystem operations to manage its context.

### Environment-scoped versus agent-scoped context

Environments that a Letta agent runs in may have additional context specific to the environment, such as skills, curated memory files, and other files:

- **External Context that is part of the environment**: A Letta agent may work in a project that contains a CLAUDE.md/AGENTS.md file or project-specific skills. This is context that is part of the environment, not the agent. When a Letta agent moves across environments, the context provided by the environment changes.
- **External Context that is part of the agent**: A Letta agent has its own external context, such as its conversation history and context that it owns and manages independently. When a Letta agent moves across environments, external context that is part of its memory is still a part of the Letta agent and does not change.

When a Letta agent moves across environments, available context from the environment will change. In contrast, the agent's memory is carried across environments: the agent should always have access to the MemFS projection of its memory stored locally regardless of where it is running.

## Indexing context

The system prompt contains additional metadata about the Letta agent's context and the context in its environment. This includes:

* **Skills metadata:** The system prompt automatically contains available skills (both the Letta agent's own skills, as well as skills in the current environment)
* **External memory metadata:** The system prompt also contains information about the number of messages stored in the message history (accessible to the Letta agent), as well as the file tree structure of its memory filesystem.

The Letta agent is responsible for maintaining additional metadata in its system prompt for additional indexing of context outside of the current context window. Letta agents can create paths of discovery by creating references and links between different fragments of context. Both external files and folders can be referenced, along with skills (which by default have metadata included in the system prompt):

* \`\[\[skills/using-slack/[SKILL.md](http://SKILL.md)\]\]\` (reference a skill)
* \`\[\[reference/[api.md](http://api.md)\]\]\` (reference an external memory file)
* \`\[\[projects/letta-code\]\` (reference a folder)

These links provide breadcrumbs for discovery for the future. Letta agents can follow the proper reference paths to efficiently load the context they need, as needed.

## The Message History

The Letta agent can see the current in-context messages, which include user messages, assistant messages, system messages, and tool calls and tool returns. All messages are automatically stored and indexed, so are always accessible to the Letta agent, but may not be currently in the context window.

### Conversations

An individual Letta agent can have multiple concurrent conversations. Each conversation is an isolated message thread, but memory is shared across all conversations. A Letta agent can search or list message history across all conversations or within a conversation. A Letta agent can also call itself as a subagent (see below) through creating an isolated conversation with itself.

## Compaction

The in-context message history of a conversation will be compacted once a specified context size is exceeded. The compaction will produce a summary message, which is the first message in the in-context message buffer. The summary message summarizes prior conversational context, and also provides references to files or previous messages that may be relevant to the current conversation.

## Subagents

Letta agents can invoke subagents to both isolate context and also have additional tasks run in the background. Letta agents also have access to specific subagents designed for context management:

* Recall: Specialized in recalling past conversations
* Reflection: Specialized in reviewing conversations to make modifications to memory
* Defragmentation: Specializes in reviewing memory and improving its structure and organization

These subagents can be leveraged to refine token-space representations over time without interfering with the context window reserved from the primary tasks.