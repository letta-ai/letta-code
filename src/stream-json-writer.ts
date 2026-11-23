import type { WireMessage } from "./types/protocol";

function stampWireMessage(msg: WireMessage): WireMessage {
  return msg.timestamp === undefined
    ? { ...msg, timestamp: new Date().toISOString() }
    : msg;
}

export function writeWireMessage(msg: WireMessage): void {
  console.log(JSON.stringify(stampWireMessage(msg)));
}

export async function writeWireMessageAsync(
  msg: WireMessage,
): Promise<boolean> {
  const line = `${JSON.stringify(stampWireMessage(msg))}\n`;

  return await new Promise<boolean>((resolve, reject) => {
    if (process.stdout.destroyed || process.stdout.writableEnded) {
      resolve(false);
      return;
    }

    process.stdout.write(line, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(true);
    });
  });
}
