import { expect, test } from "bun:test";
import { resolveCursorTestModel } from "./cursor-test-model";

function fixture(ids: string[], rejected: string[] = [], error?: string) {
  const probed: string[] = [];
  let listings = 0;
  const dependencies = {
    listCursorModels: async () => {
      listings++;
      return ids.map((id) => ({ id }));
    },
    runCursorTurn: async (options: { model?: string }) => {
      const model = options.model ?? "";
      probed.push(model);
      const failure =
        error ??
        (rejected.includes(model)
          ? `AI Model Not Found Model name is not valid: "${model}"`
          : undefined);
      return {
        agentId: "cursor-probe",
        success: !failure,
        report: "OK",
        error: failure,
      };
    },
  };
  return { dependencies, probed, listings: () => listings };
}

test("honors an accepted explicit model even outside the curated catalog", async () => {
  const f = fixture([]);
  expect(await resolveCursorTestModel("/tmp", "explicit", f.dependencies)).toBe(
    "explicit",
  );
  expect(f.listings()).toBe(0);
});

test("falls back when the explicit model and a stale catalog entry are rejected", async () => {
  const f = fixture(
    ["gpt-mini", "haiku-retired", "haiku-current"],
    ["override", "haiku-retired"],
  );
  expect(await resolveCursorTestModel("/tmp", "override", f.dependencies)).toBe(
    "haiku-current",
  );
  expect(f.probed).toEqual(["override", "haiku-retired", "haiku-current"]);
});

test("unset override chooses a mini when no haiku is available", async () => {
  const f = fixture(["flagship", "gemini-flash", "gpt-mini"]);
  expect(await resolveCursorTestModel("/tmp", "", f.dependencies)).toBe(
    "gpt-mini",
  );
});

test("reports available models instead of silently using a flagship", async () => {
  const f = fixture(["flagship", "haiku-retired"], ["haiku-retired"]);
  await expect(
    resolveCursorTestModel("/tmp", "", f.dependencies),
  ).rejects.toThrow("Available models: flagship, haiku-retired");
});

test("does not mask auth or transport failures with model fallback", async () => {
  const f = fixture(["gpt-mini"], [], "Unauthorized");
  await expect(
    resolveCursorTestModel("/tmp", "override", f.dependencies),
  ).rejects.toThrow("Unauthorized");
  expect(f.probed).toEqual(["override"]);
  expect(f.listings()).toBe(0);
});

test("falls back after SDK catalog validation rejects an override", async () => {
  const f = fixture(["gpt-mini"]);
  const run = f.dependencies.runCursorTurn;
  f.dependencies.runCursorTurn = async (options) =>
    options.model === "retired"
      ? {
          agentId: "cursor-probe",
          success: false,
          report: "",
          error: "Cannot use this model: retired. Available models: gpt-mini",
        }
      : run(options);
  expect(await resolveCursorTestModel("/tmp", "retired", f.dependencies)).toBe(
    "gpt-mini",
  );
});
