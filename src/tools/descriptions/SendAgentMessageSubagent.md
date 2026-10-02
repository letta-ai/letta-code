# SendAgentMessage

Send a message to another agent's conversation without waiting for an answer.
With no `agent_id` or `conversation_id`, it goes to your parent: the agent and
conversation that launched you.

Use this rarely. A mid-task message lands in two conversations and stays in both
contexts for the rest of the work, taxing you and your parent on every turn that
follows. Your final report already reaches your parent; findings, assumptions,
and open questions belong there.

The case that warrants a message: one decision from your parent determines work
you would otherwise have to redo, and you have other work to get on with while
you wait. Send a single message with what you need, the options you see, and the
default you will take if no answer comes, then keep working. If instead nothing
can proceed without the answer, end with a report naming the blocker; that costs
the same as asking and leaves nothing hanging, and your parent can answer and
resume you. If your parent explicitly asked for certain updates, send exactly
those.

Ordinary assistant output is not forwarded; only this tool and your final report
reach your parent. A successful send means Cloud accepted the message, not that
it was read. Replies arrive as new messages, so keep working rather than checking
for one. Letta-to-Letta messages require the Cloud backend. To message another
agent, supply `conversation_id`, or `agent_id` to start a new thread with it.
