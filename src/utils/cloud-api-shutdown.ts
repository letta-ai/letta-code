export const CLOUD_API_UNAVAILABLE_MESSAGE =
  "Service temporarily unavailable. Please retry your request.";

export type CloudApiShutdownError = {
  status: 503;
  error: Record<string, unknown>;
  headers?: unknown;
};

export type CloudApiDeploymentInterruptedError = {
  error_type: "internal_error";
  error_code: "cloud_api_deployment_interrupted";
  status_code: 503;
  retryable: true;
  run_id?: string;
};

export function isCloudApiDeploymentInterrupted(
  error: unknown,
): error is CloudApiDeploymentInterruptedError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { error_type?: unknown }).error_type === "internal_error" &&
    (error as { error_code?: unknown }).error_code ===
      "cloud_api_deployment_interrupted" &&
    (error as { status_code?: unknown }).status_code === 503 &&
    (error as { retryable?: unknown }).retryable === true
  );
}

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

export function shouldEmitRetryNotice(error: unknown): boolean {
  return !isCloudApiShutdownRejection(error);
}
