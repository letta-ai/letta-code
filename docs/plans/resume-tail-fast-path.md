# Resume tail fast path plan

## Contract

Boot/resume should use one small-tail algorithm for local and API backends:

1. Resolve the active agent and conversation using existing Letta CLI behavior.
2. If resuming, fetch a bounded tail for that exact conversation.
3. Convert that tail into TUI buffer lines.
4. Detect pending approvals from the literal tail.
5. Render the tail and show either the approval UI or the normal input.

Default Letta behavior stays stateful: normal startup resumes the default/last conversation.

## Backend boundary

Add a backend-level resume-tail operation, conceptually:

```ts
type ResumeTail = {
  messages: Message[];
  pendingApprovals: ApprovalRequest[];
};

getConversationResumeTail(agentId: string, conversationId: string, limit: number): Promise<ResumeTail>;
```

- API backend: uses bounded conversation message APIs and any required conversation metadata lookup.
- Local backend: reads only the active conversation transcript tail from local storage.
- Selectors/search may enumerate conversations; normal boot must not.

## Decisions

- Tail size should be small and bounded. Start with the existing visual target: enough for recent context, not hundreds of raw messages.
- Pending approval is determined by unresolved approval/tool-call state in the tail: approval request exists and no matching tool result/approval response follows it.
- The UI should not become `ready` and then do an expensive post-ready transcript replay.
- The local fast path must not call APIs that rebuild global message indexes or scan unrelated conversations.
- Keep existing hosted/API semantics, but route them through the same tail contract.

## Non-goals

- Do not change default resume semantics.
- Do not change conversation selectors/search behavior except to keep enumeration out of boot.
- Do not rewrite the transcript storage format in this PR.
