export const CLOUD_API_UNAVAILABLE_MESSAGE =
  "Service temporarily unavailable. Please retry your request.";

export type CloudApiShutdownError = {
  status: 503;
  error: Record<string, unknown>;
  headers?: unknown;
};

export function isCloudApiShutdownRejection(
  error: unknown,
): error is CloudApiShutdownError {
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as Partial<CloudApiShutdownError>;
  if (candidate.status !== 503) return false;
  if (typeof candidate.error !== "object" || candidate.error === null) {
    return false;
  }

  const payload = candidate.error as Record<string, unknown>;
  return (
    payload.errorCode === "cloud_api_shutting_down" &&
    payload.admitted === false &&
    payload.retryable === true
  );
}
