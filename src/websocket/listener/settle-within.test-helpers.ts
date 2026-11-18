/**
 * Bounds an await that would otherwise hang until the per-test timeout, so a
 * stall reports which step never settled instead of a bare timeout.
 */
export async function settleWithin<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${message} within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
