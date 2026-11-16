/**
 * Timeouts for steering a running Claude Code worker. Shared by the listener
 * that steers the worker and the remote caller that waits for its answer, so
 * the caller can't give up before the listener has replied.
 */

/** How long a steer waits for Claude's current turn to become interruptible. */
export const CLAUDE_TURN_START_TIMEOUT_MS = 60_000;

/** How long a steer waits for Claude to acknowledge the interrupt. */
export const CLAUDE_CONTROL_RESPONSE_TIMEOUT_MS = 30_000;

/**
 * How long a remote caller waits for a follow-up (steer or resume) answer.
 * Covers the listener's worst case (turn start + interrupt ack) plus margin
 * for building the worker environment and the network round trip.
 */
export const REMOTE_SUBAGENT_MESSAGE_TIMEOUT_MS =
  CLAUDE_TURN_START_TIMEOUT_MS + CLAUDE_CONTROL_RESPONSE_TIMEOUT_MS + 30_000;

/** Listener error when Claude's turn didn't become interruptible in time. */
export const CLAUDE_TURN_START_TIMEOUT_ERROR =
  "Claude turn did not become interruptible";

/** Listener error when Claude didn't acknowledge the interrupt in time. */
export const CLAUDE_INTERRUPT_ACK_TIMEOUT_ERROR =
  "Claude interrupt acknowledgement timed out";
