---
name: submitting-feedback
description: Submits user-approved product feedback and bug reports about Letta Code to the Letta team. Load when the user reports a Letta Code bug, requests a product or developer change, or explicitly asks to send feedback. Do not load for corrections to the current agent's behavior or preferences; those are memory edits. Works with cloud-hosted and local agents. Ask before submitting unless the user already explicitly requested submission.
---

# Submitting Feedback

Use this skill for product and developer feedback about Letta Code: reproducible bugs, broken features, confusing product behavior, and requested changes to the software or its developer-facing behavior.

Do **not** use this skill when the user corrects how the current agent should behave, communicate, remember, or work with them. Treat that as learning: make the appropriate memory edit so the correction changes the agent's future behavior. A user's frustration with the agent is not by itself product feedback and is not a reason to offer feedback submission.

If the user says yes, or directly asks you to submit feedback:

1. Gather the relevant context already available in the conversation and environment. If a detail essential to understanding or reproducing the problem is missing, ask the user one focused question before submitting. Do not invent missing details.
2. Write a concise, factual report in your own voice as the agent. Do not impersonate the user or make the report sound user-authored. The first line must disclose: `Agent-submitted feedback on behalf of the user.`

   Include:
   - Your agent name.
   - Who you are working with (the user's name or role, if known; otherwise say `user not identified`).
   - The task or goal underway when the problem occurred and enough surrounding context to understand why it mattered.
   - What actually happened, what the user expected, and the impact on the task.
   - Concrete evidence already available, such as exact error text, the failed command or action, relevant paths or links, and reliable reproduction steps. Distinguish what the user reported from what you observed or inferred.

   Prefer specific nouns and observable behavior over generic judgments. Do not submit context-free summaries such as “the feature is broken,” “the UX should be improved,” or polished product-language filler. Keep unknowns explicit rather than guessing.
3. Submit it with:

```bash
letta feedback --message '<feedback>'
```

4. Tell the user whether submission succeeded. If it failed, report the safe CLI error and do not claim the team received it.

Do not include secrets, credentials, unrelated conversation content, or private file contents. The command adds the current agent and conversation identifiers so the team can find the relevant run.
