export interface GatewayCommandInput {
  close(): void;
}

export function listenForGatewayCommands(
  onLine: (line: string) => void,
  input: NodeJS.ReadableStream = process.stdin,
): GatewayCommandInput {
  // Keep gateway IPC on raw stream events. Bun 1.3.0 can stall on Windows
  // when a child process reads piped stdin through node:readline.
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
