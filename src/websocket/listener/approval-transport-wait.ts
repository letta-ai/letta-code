export type ApprovalTransportOpenResult = "open" | "interrupted";

export type WaitForApprovalTransportOpen = (
  isDeliveryReady: () => boolean,
  shouldInterrupt: () => boolean,
) => Promise<ApprovalTransportOpenResult>;

const APPROVAL_TRANSPORT_REOPEN_POLL_MS = 50;

export async function waitForApprovalTransportOpen(
  isDeliveryReady: () => boolean,
  shouldInterrupt: () => boolean,
): Promise<ApprovalTransportOpenResult> {
  if (isDeliveryReady()) return "open";
  while (!shouldInterrupt()) {
    await new Promise((resolve) =>
      setTimeout(resolve, APPROVAL_TRANSPORT_REOPEN_POLL_MS),
    );
    if (isDeliveryReady()) return "open";
  }
  return "interrupted";
}
