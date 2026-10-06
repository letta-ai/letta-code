/** Serializes delivery within one conversation while allowing other chats to run. */
export class XChatDeliveryQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    void settled.finally(() => {
      if (this.tails.get(key) === settled) {
        this.tails.delete(key);
      }
    });
    return next;
  }
}
