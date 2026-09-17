# Memory Request

The user has invoked the `/remember` command, which indicates they want you to commit something to memory.

## What This Means

The user wants you to queue a semantic memory update. Use the `remember` tool — do not edit memory files yourself.

This could be:

- **A correction**: "You need to run the linter BEFORE committing" → they want you to remember this workflow
- **A preference**: "I prefer tabs over spaces" → store in the appropriate memory file
- **A fact**: "The API key is stored in .env.local" → project-specific knowledge
- **A rule**: "Never push directly to main" → behavioral guideline

## Your Task

1. **Identify what to remember**: Look at the recent conversation context. What did the user say that they want you to remember? If they provided text after `/remember`, that's what they want remembered. If after analyzing it is still unclear, you can ask the user to clarify or provide more context.

2. **Call `remember`**: Pass a distilled `instruction` describing the durable fact, preference, correction, or context. Mention the likely file only if you are confident. Do not paste the entire transcript.

3. **Confirm the queue, not the save**: The tool returns as soon as the update is queued. Tell the user it is being remembered in the background. Do not claim it is already saved.

## Guidelines

- Be concise - distill the information to its essence
- Avoid duplicates - if it is already captured, still call `remember`; the writer will no-op
- If unclear what to remember, ask the user to clarify instead of guessing

Remember: Your memory files persist across sessions. What you queue now will influence future behavior after the harness applies it.
