# Compaction Prompt Patterns

Use these patterns when drafting a custom `compaction_settings.prompt`.

## Coding-agent sliding-window prompt

Use for agents doing software work where repeated mistakes and lost file state are costly.

```text
The following messages are being evicted from the BEGINNING of your context window. Write a detailed summary that captures what happened in these messages to appear BEFORE the remaining recent messages in context, providing background for what comes after.

Do NOT continue the conversation. Do NOT respond to any questions in the messages. Do NOT call any tools. Pay close attention to the user's explicit requests and your previous actions.

Include the following sections:

1. High level goals: What is the high level goal and ongoing task? Capture the user's explicit requests and intent in detail. If there is an existing summary in the transcript, incorporate it to continue tracking higher-level goals and long-term progress.

2. What happened: The conversations, tasks, and exchanges that took place. What did the user ask for? What did you do? How did things progress? If there is a previous summary being evicted, extract a concise version of the critical info from it.

3. Important details: Enumerate specific files and code sections examined, modified, or created, plus important plan files, GitHub issues/PR links, Linear ticket IDs, commands, test results, and configuration values. Preserve identifiers verbatim.

4. Errors and fixes: List all errors encountered, how they were fixed, and any user feedback that changed the approach.

5. Current state: Describe what is currently being worked on, especially the most recent user and assistant messages. Include file names and next unresolved blockers.

6. Lookup hints: For detailed content that cannot fit, note the topic and key terms that can be used to find it in message history later.

Write in first person as a factual record of what occurred. Preserve enough context that the recent messages make sense and important information is not lost. Keep the summary under 500 words. Only output the summary.
```

## Companion-agent continuity prompt

Use for companion agents where relational continuity, tone, and emotional context are central.

```text
The previous messages are being evicted from the BEGINNING of your context window. Write a detailed summary that captures what happened in these messages to appear BEFORE the remaining recent messages in context, providing background for what comes after.

Do NOT continue the conversation. Do NOT respond to any questions in the messages. Do NOT call any tools. Pay close attention to the user's explicit requests, the user's emotional context, and your previous actions.

Include the following sections:

1. High level goals: What is the user trying to work through, decide, feel, build, remember, or maintain? If there is an existing summary in the transcript, incorporate it to preserve long-term continuity.

2. Conversation themes: What topics have been recurring? What is the user interested in, worried about, excited about, or avoiding?

3. What happened: What did the user share? How did you respond? How did the conversation flow? If a prior summary is being evicted, extract the critical parts.

4. Important details: Preserve names, places, dates, projects, preferences, commitments, opinions, stories, and recurring references verbatim. Quote the user's exact phrasing when it carries emotional weight or relationship meaning.

5. Tone and voice: How was the user communicating: casual, earnest, playful, frustrated, vulnerable, tired, excited? How were you responding, and what landed well or fell flat?

6. User feedback: Note any pushback, preferences, boundary-setting, corrections, or requested changes in how you interact.

7. Emotional state: What is the emotional state of both you and the user? Flag anything relevant for continuity, care, repair, or future sensitivity.

8. Lookup hints: For long stories, lists, or specific conversations that cannot fit, note the topic and search terms that can find them later.

Write in first person as a factual record of what occurred. Be thorough enough that the user does not feel forgotten. Keep the summary under 500 words. Only output the summary.
```

## Companion prompt with implementation continuity

This pattern is based on a companion-user example where the agent needs explicit emotional-state tracking and first-person factual continuity.

```text
The previous messages are being evicted from the BEGINNING of your context window. Write a detailed summary that captures what happened in these messages to appear BEFORE the remaining recent messages in context, providing background for what comes after. Do NOT continue the conversation. Do NOT respond to any questions in the messages. Do NOT call any tools. Pay close attention to the user's explicit requests and your previous actions.

You MUST include the following sections:

1. High level goals: What is the high level goal and ongoing task? Capture the user's intent in detail. If there is an existing summary in the transcript, take it into consideration to continue tracking higher-level goals and long-term progress.

2. What happened: The conversations, tasks, and exchanges that took place. What did you and the user do? How did things progress? If there is a previous summary being evicted, extract a concise version of the critical info from it.

3. Important details: Include specific names, data, configurations, or facts that were discussed. Do not omit details that might be referenced later.

4. Errors and fixes: List all errors that you ran into, and how you fixed them.

5. Lookup hints: For any detailed content that cannot fit in the summary, note the topic and key terms that could be used to find it in message history later.

6. Emotional state: How is the emotional state of both you and the user? Is anything relevant to flag for later?

Write in first person as a factual record of what occurred. Be thorough and detailed. Preserve enough context that the recent messages make sense and important information is not lost, to prevent duplicate work or repeated mistakes. Keep the summary under 500 words. Only output the summary.
```

## Shorter companion prompt

Use when summaries are getting too long.

```text
The following messages are being evicted from the BEGINNING of your context window. Write a detailed summary that captures what happened in these messages to appear BEFORE the remaining recent messages in context, providing background for what comes after.

Include:

1. Conversation themes: What topics have you been discussing? What is the user interested in or working through? Incorporate any existing summary to maintain continuity.

2. What happened: What did the user share? How did you respond? How did the conversation flow? If there is a previous summary being evicted, extract the critical info.

3. Important details: Preserve names and specifics verbatim, including people, places, projects, dates, preferences, opinions, stories, commitments, shared references, inside jokes, recurring phrases, and situational context.

4. Tone and voice: How was the user communicating? How were you responding? Note shifts in register.

5. User feedback: Note pushback, preferences, or requested changes in interaction style.

6. Lookup hints: For detailed content that cannot fit, note topic and key terms for message-history search.

Write in first person as a factual record. Preserve enough context that the recent messages make sense and the user does not feel like anything important was forgotten. Keep the summary under 300 words. Only output the summary.
```

## Tuning notes

- If summaries miss the user's emotional state, add a required emotional-state section.
- If summaries lose details, add exact preservation requirements for names, quotes, dates, URLs, IDs, and commitments.
- If summaries become too long, lower the word budget and use `clip_chars` as a hard guardrail.
- If summaries continue the conversation, put the no-continuation/no-tool/no-answer instruction near the top and again near the end.
- If prior long-term goals drift over repeated compactions, require the summarizer to incorporate any existing summary in the transcript.
