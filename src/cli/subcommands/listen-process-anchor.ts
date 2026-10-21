import { MessageChannel } from "node:worker_threads";

type ListenerProcessAnchor = {
  close: () => void;
};

type CreateListenerProcessAnchor = () => ListenerProcessAnchor;

const activeListenerProcessAnchors = new Set<ListenerProcessAnchor>();

function createMessageChannelProcessAnchor(): ListenerProcessAnchor {
  const { port1, port2 } = new MessageChannel();

  port1.ref();
  port2.ref();

  return {
    close: () => {
      port1.close();
      port2.close();
    },
  };
}

export function createListenerProcessAnchorPromise(
  createProcessAnchor: CreateListenerProcessAnchor = createMessageChannelProcessAnchor,
): Promise<number> {
  const anchor = createProcessAnchor();

  activeListenerProcessAnchors.add(anchor);

  return new Promise<number>(() => {
    // Never resolves - runs until the process receives a shutdown signal.
    // The ref'ed MessageChannel above is a zero-wakeup process anchor for
    // channel-only listeners whose adapters may not own a persistent handle.
  });
}
