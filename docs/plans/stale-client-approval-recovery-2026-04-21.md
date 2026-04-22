## Stale Client Approval Recovery

### Problem

Some client-side approval recovery paths replay auto-allowed tools after the
backend restores `pendingApprovals`. That is unsafe for replay-sensitive tools
like `MessageChannel`, because the tool may already have run locally before the
session was interrupted.

### Canonical policy

1. If we already have a real local approval result, resend or queue that result.
2. If we do not have the real local result, never auto-rerun replay-unsafe
   client-side tools from backend-restored pending approvals.
3. Instead, synthesize denial results for those stale approvals.
4. For startup / restored-session recovery, queue those synthetic denials and
   send them with the next user message.
5. For in-flight stale approval conflicts, synthesize denials immediately and
   retry the turn.

### Misaligned paths on main

- `src/cli/App.tsx`
  - `recoverRestoredPendingApprovals(...)`
  - `checkPendingApprovalsForSlashCommand(...)`
  - resumed-session eager approval handling inside `onSubmit(...)`
- `src/headless.ts`
  - `resolveAllPendingApprovals(...)` recovery branches
- `src/websocket/listener/send.ts`
  - `resolveStaleApprovals(...)`
- `src/websocket/listener/recovery.ts`
  - restored approval sync recovery

### Intended fix

- Add a shared helper for building queued stale-denial approval results.
- Replace replay-prone restore/recovery branches with that helper.
- Keep existing in-memory queued-result resend behavior for same-process
  interrupted executions.
- Add tests that prove stale restored approvals become denial payloads instead
  of rerunning client-side tools.
