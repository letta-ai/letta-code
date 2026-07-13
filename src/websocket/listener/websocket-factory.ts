import WebSocket from "ws";

type ListenerWebSocketFactory = (
  url: string,
  options: { headers: { Authorization: string } },
) => WebSocket;

const defaultListenerWebSocketFactory: ListenerWebSocketFactory = (
  url,
  options,
) => new WebSocket(url, options);

let listenerWebSocketFactory = defaultListenerWebSocketFactory;

export function createAuthenticatedListenerWebSocket(
  url: string,
  apiKey: string,
): WebSocket {
  return listenerWebSocketFactory(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

export function setListenerWebSocketFactoryForTests(
  factory: ListenerWebSocketFactory | null,
): void {
  listenerWebSocketFactory = factory ?? defaultListenerWebSocketFactory;
}
