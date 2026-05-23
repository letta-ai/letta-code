let activeConnectAbortController: AbortController | null = null;

export function setActiveConnectAbortController(
  controller: AbortController | null,
): void {
  activeConnectAbortController = controller;
}

export function isActiveConnectOperationCancellable(): boolean {
  return activeConnectAbortController !== null;
}

export function cancelActiveConnectOperation(): boolean {
  if (!activeConnectAbortController) {
    return false;
  }
  activeConnectAbortController.abort();
  return true;
}
