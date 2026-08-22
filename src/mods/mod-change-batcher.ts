export function createModChangeBatcher(onChange: () => void) {
  let batching = false;
  let changePending = false;

  const notify = () => {
    if (batching) {
      changePending = true;
      return;
    }
    onChange();
  };

  const finish = (publish: boolean) => {
    batching = false;
    if (!changePending) return;
    changePending = false;
    if (publish) onChange();
  };

  return {
    notify,
    async run<T>(operation: () => Promise<T> | T): Promise<T> {
      batching = true;
      try {
        const result = await operation();
        finish(true);
        return result;
      } catch (error) {
        finish(false);
        throw error;
      }
    },
    runSync<T>(operation: () => T): T {
      batching = true;
      try {
        return operation();
      } finally {
        finish(true);
      }
    },
  };
}
