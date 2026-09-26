import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "@/settings-manager";
import { executeWorkflow } from "@/tools/workflow/workflow-engine";

// The CI API integration matrix provides LETTA_API_KEY; a missing key is a
// configuration failure, not a reason to skip live endpoint coverage.
test("Workflow decide() evaluates choice and noul through Letta Cloud", async () => {
  if (!process.env.LETTA_API_KEY) {
    throw new Error(
      "LETTA_API_KEY is required for the live Workflow decision test.",
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "workflow-decide-live-"));
  try {
    await settingsManager.initialize();
    const journalPath = join(dir, "journal.jsonl");
    const run = await executeWorkflow(
      async () => {
        throw new Error("This workflow must not spawn an agent.");
      },
      {
        script: `export const meta = { name: 'live-jev-decision', description: 'Verify Jev decision' }
return await decide(
  { instruction: 'Pick blue and judge whether blue was selected.' },
  {
    color: { type: 'choice', instructions: 'Select blue.', criteria: { blue: 'Blue', green: 'Green' } },
    confidence: { type: 'noul', instructions: 'Was blue selected?' }
  },
  { model: 'typesafe/jev-1.13' }
)`,
        journalPath,
      },
    );
    expect(run.agentsSpawned).toBe(0);
    const result = run.result as {
      model: string;
      id: string;
      provider: string;
      answers: Record<string, Record<string, unknown>>;
      usage: { input_tokens: number; output_tokens: number; cost: number };
    };
    expect(result.model).toMatch(/^typesafe\/jev-1\.13/);
    expect(result.id).toBeTruthy();
    expect(result.provider).toBeTruthy();
    expect(Object.keys(result.answers).sort()).toEqual(["color", "confidence"]);
    expect(result.answers.color).toMatchObject({
      type: "choice",
      calibrated: true,
    });
    expect(result.answers.color?.choice).toBeString();
    expect(["blue", "green"]).toContain(result.answers.color?.choice as string);
    expect(result.answers.confidence).toMatchObject({
      type: "noul",
      calibrated: true,
    });
    expect(result.answers.confidence?.noul).toBeNumber();
    expect(result.answers.confidence?.noul as number).toBeGreaterThanOrEqual(0);
    expect(result.answers.confidence?.noul as number).toBeLessThanOrEqual(1);
    expect(result.usage.input_tokens).toBeGreaterThan(0);
    expect(result.usage.output_tokens).toBeGreaterThan(0);
    expect(result.usage.cost).toBeGreaterThanOrEqual(0);
    expect(run.totalTokens).toBe(
      result.usage.input_tokens + result.usage.output_tokens,
    );
    const entries = (await readFile(journalPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toEqual([
      {
        kind: "decision",
        model: result.model,
        cost: result.usage.cost,
        calibrated: true,
        valid: true,
        totalTokens: run.totalTokens,
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 45_000);
