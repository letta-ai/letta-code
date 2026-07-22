const LOCAL_NO_MODEL_WITHOUT_CLOUD_AUTH = [
  "It looks like we're in local mode, but we don't have any models available yet.",
  "",
  "to get set up, you can either:",
  "- run `/connect` to add a provider from inside letta code",
  "- export a provider key in your env and restart `letta`, for example `export OPENAI_API_KEY=...`",
  "- or run `/login` if you'd rather use models available through Letta Cloud",
  "",
  "once one of those is set up, send your message again and we can get started.",
].join("\n");

const LOCAL_NO_MODEL_WITH_CLOUD_AUTH = [
  "It looks like we're in local mode, but we don't have any models available yet.",
  "",
  "to get set up, you can either:",
  "- run `/connect` to add a provider from inside letta code",
  "- export a provider key in your env and restart `letta`, for example `export OPENAI_API_KEY=...`",
  "",
  "if you'd rather use models available through Letta Cloud instead, switch back to OAuth mode and try again.",
  "",
  "once a model is available, send your message again and we can get started.",
].join("\n");

export function buildLocalNoModelResponse(hasCloudAuth: boolean): string {
  return hasCloudAuth
    ? LOCAL_NO_MODEL_WITH_CLOUD_AUTH
    : LOCAL_NO_MODEL_WITHOUT_CLOUD_AUTH;
}

export function splitSyntheticAssistantResponse(text: string): string[] {
  const chunks: string[] = [];
  const lines = text.split(/(\n)/);

  for (const line of lines) {
    if (line === "") {
      continue;
    }
    if (line === "\n") {
      chunks.push(line);
      continue;
    }

    const parts = line.match(/\S+\s*|\s+/g) ?? [line];
    let current = "";
    for (const part of parts) {
      current += part;
      const trimmed = current.trimEnd();
      const shouldFlush =
        trimmed.endsWith(",") ||
        trimmed.endsWith(".") ||
        trimmed.endsWith(":") ||
        trimmed.endsWith("?") ||
        trimmed.endsWith("!") ||
        current.length >= 28;
      if (shouldFlush) {
        chunks.push(current);
        current = "";
      }
    }

    if (current) {
      chunks.push(current);
    }
  }

  return chunks.length > 0 ? chunks : [text];
}
