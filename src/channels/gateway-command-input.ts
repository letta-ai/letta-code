export interface GatewayCommandInput {
  close(): void;
}

export function listenForGatewayCommands(
  onLine: (line: string) => void,
  input: NodeJS.ReadableStream = process.stdin,
): GatewayCommandInput {
  let buffer = "";
  const onData = (chunk: string | Buffer): void => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      onLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
    }
  };
  input.on("data", onData);
  return {
    close: () => {
      input.removeListener("data", onData);
      input.pause();
    },
  };
}
