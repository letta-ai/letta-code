# CLI App Layout

`src/cli/App.tsx` is the public entrypoint. This directory holds the actual
implementation, split by responsibility so agents can open the smallest useful
file first.

- `App.tsx`: local entrypoint that re-exports the coordinator.
- `AppCoordinator.tsx`: Ink state, effects, overlay wiring, and render tree.
- `AppView.tsx`: render-only Ink tree for the coordinator.
- `useSubmitHandler.ts`: slash-command and user-submit router.
- `useConversationLoop.ts`: streaming turn loop, retry/recovery, tool execution,
  and reflection auto-launch.
- `useApprovalFlow.ts`: approval recovery and approve/deny batching.
- `useConversationSwitching.ts`: `/btw`, agent selection, and new-agent
  conversation switching flows.
- `useBashHandlers.ts`: bash-mode submit/interrupt handling.
- `useQueuedApprovalSubmit.ts`: stale approval recovery helpers used before
  slash-command sends.
- `useFeedbackHandler.ts`: `/feedback` submission and diagnostics payload.
- `useInterruptHandler.ts`: ESC interrupt, cancellation, and recovery cleanup.
- `useReasoningCycle.ts`: reasoning-tier tab cycling and debounced persistence.
- `useConfigurationHandlers.ts`: model/system/personality/toolset/experiment
  selectors and their queued overlay actions.
- `constants.ts`: timing, retry, provider fallback, and layout constants.
- `modelConfig.ts`: model handle, reasoning effort, and model error hint helpers.
- `commandRouting.ts`: slash command queue-bypass classification.
- `approvalDiffs.ts`, `approvalQuestions.ts`: approval helpers.
- `ids.ts`, `layout.ts`, `contentParts.ts`, `systemReminders.ts`: transcript and content utilities.
- `reflection.ts`, `retry.ts`, `session.ts`, `notifications.ts`, `errors.ts`: focused runtime helpers.
- `StaticTranscript.tsx`, `ExitStats.tsx`: render-only pieces extracted from the coordinator.
- `types.ts`: app props and static transcript item types.

The split intentionally mirrors the listener layout at a coarse level:
`useConversationLoop.ts` is the interactive analogue of listener `turn.ts`,
while `useSubmitHandler.ts` owns the command-routing surface that can converge
with listener command handling in a later PR.
