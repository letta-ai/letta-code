import { listCursorModels, runCursorTurn } from "@/tools/impl/cursor-session";

// The catalog can lag inference availability. Probe before running assertions,
// and only fall back for model-name rejection (never auth or transport errors).
export async function resolveCursorTestModel(
  cwd: string,
  requested = process.env.CURSOR_TEST_MODEL,
  dependencies = { listCursorModels, runCursorTurn },
): Promise<string> {
  const rejected: string[] = [];
  async function accepts(model: string): Promise<boolean> {
    const result = await dependencies.runCursorTurn({
      cwd,
      parentAgentId: "agent-cursor-model-probe",
      model,
      prompt: "Reply OK. Do not use tools.",
      signal: AbortSignal.timeout(30_000),
    });
    if (result.success) return true;
    if (
      !/AI Model Not Found|Model name is not valid|Cannot use this model:/i.test(
        result.error ?? "",
      )
    )
      throw new Error(
        `Cursor test model ${model} probe failed: ${result.error}`,
      );
    rejected.push(model);
    return false;
  }
  if (requested && (await accepts(requested))) {
    console.info(`Cursor lifecycle model: ${requested} (CURSOR_TEST_MODEL)`);
    return requested;
  }
  const catalog = await dependencies.listCursorModels(cwd, process.env);
  const ids = catalog.flatMap((entry) =>
    typeof entry === "object" &&
    entry !== null &&
    "id" in entry &&
    typeof entry.id === "string"
      ? [entry.id]
      : [],
  );
  // Keep automatic selection in small model families; never silently use Auto
  // or an expensive flagship when the provider retires a cheap model.
  for (const family of [/\bhaiku\b/i, /\bmini\b/i, /\bflash\b/i]) {
    for (const id of ids.filter((id) => family.test(id))) {
      if (rejected.includes(id) || !(await accepts(id))) continue;
      console.info(
        `Cursor lifecycle model: ${id} (live catalog; rejected: ${rejected.join(", ") || "none"})`,
      );
      return id;
    }
  }
  throw new Error(
    `No accepted small Cursor test model. CURSOR_TEST_MODEL: ${requested ?? "unset"}. ` +
      `Rejected: ${rejected.join(", ") || "none"}. Available models: ${ids.join(", ") || "none"}`,
  );
}
