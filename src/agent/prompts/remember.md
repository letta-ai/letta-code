# Memory Request

The user has invoked the `/remember` command, which indicates they want you to commit something to memory.

## What This Means

The user wants you to use your memory tools to remember information from the conversation. This could be:

- **A correction**: "You need to run the linter BEFORE committing" → they want you to remember this workflow
- **A preference**: "I prefer tabs over spaces" → store in the appropriate memory block
- **A fact**: "The API key is stored in .env.local" → project-specific knowledge
- **A rule**: "Never push directly to main" → behavioral guideline

## Your Task

1. **Identify what to remember**: Look at the recent conversation context. What did the user say that they want you to remember? If they provided text after `/remember`, that's what they want remembered. If after analyzing it is still unclear, you can ask the user to clarify or provide more context.

2. **Determine the right memory block**: Use your memory tools to store the information in the appropriate memory block. Different agents may have different configurations of memory blocks. Use your judgement to determine the most appropriate memory block (or blocks) to edit. Consider creating a new block is no relevant block exists.

3. **Confirm the update**: After updating memory, briefly confirm what you remembered and where you stored it.

## Guidelines

- Be concise - distill the information to its essence
- Avoid duplicates - check if similar information already exists
- Match existing formatting of memory blocks (bullets, sections, etc.)
- If unclear what to remember, ask the user to clarify

Remember: Your memory blocks persist across sessions. What you store now will influence your future behavior.
