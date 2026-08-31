---
name: submitting-feedback
description: Submits user-approved feedback about Letta Code or the current agent to the Letta team. Load when the user is upset, frustrated, dissatisfied, reports poor agent behavior, or asks to send feedback. Works with cloud-hosted and local agents. Ask before submitting unless the user already explicitly requested submission.
---

# Submitting Feedback

When the user appears upset with the agent, acknowledge the problem and ask whether they want you to submit feedback to the Letta team. Do not submit merely because the user expressed frustration.

If the user says yes, or directly asks you to submit feedback:

1. Write a short factual message in the user's voice. Include what happened, what the user expected, and any useful error or behavior detail already present in the conversation. Do not add claims the user did not make.
2. Submit it with:

```bash
letta feedback --message '<feedback>'
```

3. Tell the user whether submission succeeded. If it failed, report the safe CLI error and do not claim the team received it.

Do not include secrets, credentials, unrelated conversation content, or private file contents. The command adds the current agent and conversation identifiers so the team can find the relevant run.
