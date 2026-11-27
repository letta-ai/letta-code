import WebSocket from "ws";
import { isRecord } from "@/utils/type-guards";

export function terminalSocket(
  receive: (event: Record<string, unknown>) => void,
) {
  return class TerminalSocket extends WebSocket {
    constructor(address: string, options?: WebSocket.ClientOptions) {
      super(address, options);
      this.on("message", (data) => {
        const text = data.toString();
        if (
          !text.includes('"update_subagent_state"') &&
          !text.includes('"turn_finished"')
        )
          return;
        let event: unknown;
        try {
          event = JSON.parse(text);
        } catch {
          return;
        }
        if (isRecord(event)) receive(event);
      });
    }
  };
}
