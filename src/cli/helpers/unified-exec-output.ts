type ParsedUnifiedExecOutput = {
  output: string;
  exitCode?: number;
  sessionId?: string;
};

function parseUnifiedExecOutput(text: string): ParsedUnifiedExecOutput | null {
  const lines = text.split("\n");
  const outputIndex = lines.indexOf("Output:");
  if (outputIndex < 0) {
    return null;
  }

  const metadataLines = lines.slice(0, outputIndex);
  if (!metadataLines.some((line) => line.startsWith("Wall time: "))) {
    return null;
  }

  const exitLine = metadataLines.find((line) =>
    line.startsWith("Process exited with code "),
  );
  const sessionLine = metadataLines.find((line) =>
    line.startsWith("Process running with session ID "),
  );
  const exitCode = exitLine
    ? Number(exitLine.replace("Process exited with code ", ""))
    : undefined;
  const sessionId = sessionLine?.replace(
    "Process running with session ID ",
    "",
  );

  return {
    output: lines.slice(outputIndex + 1).join("\n"),
    ...(Number.isFinite(exitCode) ? { exitCode } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

export function extractUnifiedExecRunningSessionId(
  text: string,
): string | null {
  return parseUnifiedExecOutput(text)?.sessionId ?? null;
}

/**
 * Codex unified exec returns model-facing metadata before the actual command
 * output. The TUI shell renderer should stay focused on what the command
 * printed, while preserving non-zero exits and running session status.
 */
export function formatUnifiedExecOutputForTui(text: string): string {
  const parsed = parseUnifiedExecOutput(text);
  if (!parsed) {
    return text;
  }

  const output = parsed.output.replace(/\n+$/, "");
  const prefix: string[] = [];
  if (parsed.exitCode !== undefined && parsed.exitCode !== 0) {
    prefix.push(`Exit code: ${parsed.exitCode}`);
  }

  const sessionStatus = parsed.sessionId
    ? `Process running with session ID ${parsed.sessionId}`
    : null;

  if (output.length > 0) {
    return [...prefix, output, sessionStatus].filter(Boolean).join("\n");
  }

  if (sessionStatus) {
    return sessionStatus;
  }

  if (prefix.length > 0) {
    return prefix.join("\n");
  }

  return "(Command completed with no output)";
}
