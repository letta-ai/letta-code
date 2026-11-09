Send a message without waiting for its answer. Use this to coordinate with an agent already working, including an Agent child, or to contact any conversation you are authorized to access. Letta-to-Letta messages require the Cloud backend and fail on the local backend (`agent-local-` IDs).

- Supply `conversation_id` to message an existing thread, or `agent_id` alone to start a new hidden thread with that agent. To use an agent's default conversation, supply its `agent_id` and `conversation_id: "default"`. Pass the full conversation ID; truncated IDs are rejected.
- Your agent and conversation IDs are attached automatically as the return address. To reply, the recipient must explicitly send to that address. Ordinary assistant output is not forwarded back to you.
- A successful send means the message was accepted; the recipient may not have read it yet. Continue working rather than waiting for the answer.
- External coding workers launched with Agent (including computer-qualified IDs from remote launches) can be messaged too. If the worker is mid-turn, the result says the message steered that turn; if it was idle, the result includes a `task_id` and you are notified when the new turn finishes.
- Omit `computer` unless a particular computer is needed. If the conversation is active on A, selecting B is rejected rather than moving the conversation.
- If delivery cannot be confirmed, check the recipient's messages before resending to avoid duplicates.
- Keep sends sparse and useful: concise assignments, specific questions, or material updates. Skip status pings and repeated acknowledgments; repeat a point only when you have something new to add.
- For work already underway, treat the agent doing it as its owner. Send what it needs, then let it decide. Do not take over or redo its work. If you think ownership should change, ask the human instead of declaring it in a message.

If you are a subagent, omitting both `agent_id` and `conversation_id` sends to your parent (the agent and conversation that launched you). Message your parent rarely: each message stays in both contexts, and your final report already reaches it. Send one only when a parent decision would otherwise force you to redo work, stating the default you will take, then keep working. Steering your own children is normal; message them as often as the work needs.

On the local backend, or from a script, use the CLI instead; it waits and prints the reply: `letta -p --from-agent $LETTA_AGENT_ID --conversation <conversation-id> --output-format json "message"` (add `--backend local` after `letta` for `agent-local-` IDs; `letta -p --help` lists options).
