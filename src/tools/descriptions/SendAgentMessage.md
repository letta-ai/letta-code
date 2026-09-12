# SendAgentMessage

Send a message to another Cloud conversation without waiting for its answer.
Use this to coordinate with an agent already working, including an Agent child,
or to contact any conversation you are authorized to access.

- Supply `conversation_id` to continue a conversation, or `agent_id` alone to
  start a new hidden conversation. `default` requires `agent_id` too.
- Your agent and conversation IDs are attached automatically as the return address.
  To reply, the recipient must explicitly send to that address. Ordinary assistant
  output is not forwarded back to you.
- `queued` means Cloud accepted the message, not that the recipient read it or
  finished. Keep the receipt; use its `status_command` or `messages_command` to inspect progress.
- Omit `computer` unless a particular computer is needed. If the conversation is
  active on A, selecting B is rejected rather than moving the conversation.
- On `acceptance_unknown`, inspect the conversation before resending. Do not
  bypass a delivery error by starting another harness.

Use Agent to launch or resume a managed child task and receive its completion
notification. SendAgentMessage only sends input; it creates no local task ID and
does not change the recipient's tools, model, or permissions. For a blocking
answer, use the messaging-agents skill's CLI send without `--no-wait`.
