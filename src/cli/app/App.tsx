/**
 * CLI app implementation entrypoint.
 *
 * Stateful orchestration lives in `AppCoordinator.tsx`; supporting concerns are
 * split into sibling modules so small-context agents can land near the code they
 * need without paging through the full TUI coordinator.
 */

export { default } from "./AppCoordinator";
