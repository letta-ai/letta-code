import { listCursorModels } from "./cursor-session";

const FAST_MODEL_TIERS = [
  "composer-2.5",
  "nano",
  "flash-lite",
  "mini",
  "luna",
  "flash",
  "haiku",
  "fast",
];

export async function resolveCursorTestModel(cwd: string): Promise<string> {
  if (process.env.CURSOR_TEST_MODEL) return process.env.CURSOR_TEST_MODEL;
  const models = await listCursorModels(cwd, process.env);
  const ids = models.flatMap((model) =>
    typeof model === "object" && model !== null && "id" in model
      ? [model.id]
      : [],
  );
  const model = FAST_MODEL_TIERS.flatMap((tier) =>
    ids.filter((id) => typeof id === "string" && id.includes(tier)),
  )[0];
  if (typeof model !== "string")
    throw new Error("Cursor did not return a fast model for lifecycle tests");
  console.log(`Cursor lifecycle model: ${model}`);
  return model;
}
