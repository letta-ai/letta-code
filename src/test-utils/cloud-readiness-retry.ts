/** Structured HTTP failure; constructing it does not opt a request into retries. */
export class CloudReadinessError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode?: string,
    message?: string,
  ) {
    super(
      `Cloud request failed: HTTP ${status}: ${errorCode ?? ""} ${message ?? ""}`,
    );
  }
}

/** Only used by registration/readiness polling, never by the teleport POST. */
export function isRetryableCloudReadinessError(error: unknown): boolean {
  return (
    error instanceof CloudReadinessError &&
    ((error.status === 503 && error.errorCode === "cloud_api_shutting_down") ||
      (!error.errorCode && [502, 503, 504].includes(error.status)))
  );
}
