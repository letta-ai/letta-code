/** Bound stop acknowledgement without leaving a timeout alive after exit. */
export async function confirmProcessExit(
  exit: Promise<unknown>,
  name: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exit,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} process exit was not confirmed`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
