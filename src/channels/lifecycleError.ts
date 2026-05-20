const RAW_LOOP_ERROR_PATTERN = /^Unexpected stop reason:\s*error$/i;

export const CHANNEL_LIFECYCLE_FALLBACK_ERROR_MESSAGE =
  "Something went wrong while processing that message. Please try again.";

export function normalizeChannelLifecycleErrorMessage(
  errorText: string | null | undefined,
): string {
  const normalized = errorText?.trim();
  if (!normalized || RAW_LOOP_ERROR_PATTERN.test(normalized)) {
    return CHANNEL_LIFECYCLE_FALLBACK_ERROR_MESSAGE;
  }
  return normalized;
}
