/** Safe, machine-readable reason a turn could not produce a result. */
export interface TerminalFailure {
  /** Execution boundary that failed. */
  stage: string;
  /** Stable machine-readable classification. */
  code: string;
  /** Bounded, user-safe explanation. */
  message: string;
  /** Upstream HTTP status when one exists. */
  http_status: number | null;
  /** Whether retrying the operation may succeed without user intervention. */
  retryable: boolean;
  /** Input identities consumed by the failed turn, used for correlation. */
  client_message_ids: string[];
}
