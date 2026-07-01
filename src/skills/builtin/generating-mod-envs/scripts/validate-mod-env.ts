#!/usr/bin/env bun
import { readFile } from "node:fs/promises";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function assertValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function optionalString(record: JsonRecord, key: string, path = key): void {
  const value = record[key];
  assertValid(
    value === undefined ||
      (typeof value === "string" && value.trim().length > 0),
    `${path} must be a non-empty string when present`,
  );
}

function optionalStringArray(
  record: JsonRecord,
  key: string,
  path = key,
): void {
  const value = record[key];
  assertValid(
    value === undefined || isStringArray(value),
    `${path} must be an array of strings`,
  );
}

function optionalPositiveNumber(
  record: JsonRecord,
  key: string,
  path = key,
): void {
  const value = record[key];
  assertValid(
    value === undefined ||
      (typeof value === "number" && Number.isFinite(value) && value > 0),
    `${path} must be a positive number`,
  );
}

function validateMemoryFiles(value: unknown, path: string): void {
  if (value === undefined) return;
  assertValid(isRecord(value), `${path} must be an object`);
  for (const [filePath, content] of Object.entries(value)) {
    assertValid(
      filePath.length > 0 && !filePath.startsWith("/"),
      `${path} paths must be relative`,
    );
    assertValid(
      typeof content === "string",
      `${path}[${filePath}] must be a string`,
    );
  }
}

function validateMarkerFields(record: JsonRecord, path: string): void {
  optionalStringArray(
    record,
    "requiredResultMarkers",
    `${path}.requiredResultMarkers`,
  );
  optionalStringArray(
    record,
    "requiredTraceMarkers",
    `${path}.requiredTraceMarkers`,
  );
  optionalStringArray(
    record,
    "forbiddenResultMarkers",
    `${path}.forbiddenResultMarkers`,
  );
  optionalStringArray(
    record,
    "forbiddenTraceMarkers",
    `${path}.forbiddenTraceMarkers`,
  );
}

function requiredMarkerCount(record: JsonRecord): number {
  return ["requiredResultMarkers", "requiredTraceMarkers"].reduce(
    (count, key) => {
      const value = record[key];
      return count + (Array.isArray(value) ? value.length : 0);
    },
    0,
  );
}

function assertionCount(record: JsonRecord): number {
  const value = record.assertions;
  return Array.isArray(value) ? value.length : 0;
}

function validateScenario(params: {
  evaluation: JsonRecord;
  index: number;
  scenario: unknown;
  warnings: string[];
}): void {
  const path = `evaluation.scenarios[${params.index}]`;
  assertValid(isRecord(params.scenario), `${path} must be an object`);
  const scenario = params.scenario;

  optionalString(scenario, "name", `${path}.name`);
  optionalString(scenario, "prompt", `${path}.prompt`);
  assertValid(
    typeof scenario.prompt === "string" ||
      typeof params.evaluation.prompt === "string" ||
      assertionCount(scenario) > 0 ||
      assertionCount(params.evaluation) > 0,
    `${path}.prompt or ${path}.assertions is required when evaluation.prompt is absent`,
  );
  assertValid(
    scenario.outputFormat === undefined ||
      scenario.outputFormat === "json" ||
      scenario.outputFormat === "stream-json",
    `${path}.outputFormat must be json or stream-json`,
  );
  optionalPositiveNumber(scenario, "timeoutMs", `${path}.timeoutMs`);
  optionalPositiveNumber(scenario, "maxTurns", `${path}.maxTurns`);
  validateMemoryFiles(scenario.memoryFiles, `${path}.memoryFiles`);
  validateMarkerFields(scenario, path);

  if (
    requiredMarkerCount(scenario) === 0 &&
    requiredMarkerCount(params.evaluation) === 0
  ) {
    params.warnings.push(
      `${path} has no required result/trace markers and no parent required markers`,
    );
  }
}

function validateEnv(env: unknown): string[] {
  assertValid(isRecord(env), "env must be a JSON object");
  assertValid(
    typeof env.name === "string" && env.name.trim(),
    "name is required",
  );
  assertValid(
    typeof env.objective === "string" && env.objective.trim(),
    "objective is required",
  );
  assertValid(
    isStringArray(env.requirements) && env.requirements.length > 0,
    "requirements must be a non-empty array of strings",
  );

  optionalString(env, "slug");
  optionalString(env, "targetModName");
  optionalStringArray(env, "candidateDiversityHints");
  optionalStringArray(env, "modApiHints");

  if (env.examples !== undefined) {
    assertValid(Array.isArray(env.examples), "examples must be an array");
    for (const [index, example] of env.examples.entries()) {
      assertValid(isRecord(example), `examples[${index}] must be an object`);
      assertValid(
        typeof example.input === "string" && example.input.trim(),
        `examples[${index}].input is required`,
      );
      assertValid(
        example.expected === undefined || typeof example.expected === "string",
        `examples[${index}].expected must be a string`,
      );
      assertValid(
        example.notes === undefined || typeof example.notes === "string",
        `examples[${index}].notes must be a string`,
      );
    }
  }

  assertValid(isRecord(env.evaluation), "evaluation is required");
  const evaluation = env.evaluation;
  optionalString(evaluation, "prompt", "evaluation.prompt");
  assertValid(
    evaluation.outputFormat === undefined ||
      evaluation.outputFormat === "json" ||
      evaluation.outputFormat === "stream-json",
    "evaluation.outputFormat must be json or stream-json",
  );
  optionalPositiveNumber(evaluation, "timeoutMs", "evaluation.timeoutMs");
  optionalPositiveNumber(evaluation, "maxTurns", "evaluation.maxTurns");
  validateMemoryFiles(evaluation.memoryFiles, "evaluation.memoryFiles");
  validateMarkerFields(evaluation, "evaluation");

  const warnings: string[] = [];
  if (evaluation.scenarios !== undefined) {
    assertValid(
      Array.isArray(evaluation.scenarios),
      "evaluation.scenarios must be an array",
    );
    assertValid(
      evaluation.scenarios.length > 0,
      "evaluation.scenarios must not be empty",
    );
    for (const [index, scenario] of evaluation.scenarios.entries()) {
      validateScenario({ evaluation, index, scenario, warnings });
    }
  } else {
    assertValid(
      typeof evaluation.prompt === "string" && evaluation.prompt.trim(),
      "evaluation.prompt is required when no scenarios are configured",
    );
    if (requiredMarkerCount(evaluation) === 0) {
      warnings.push(
        "add at least one requiredResultMarkers or requiredTraceMarkers entry so the eval can fail a placebo mod",
      );
    }
  }

  if (
    typeof env.slug === "string" &&
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(env.slug)
  ) {
    warnings.push(
      "slug should be kebab-case for stable run and candidate paths",
    );
  }
  if (
    evaluation.scenarios !== undefined &&
    Array.isArray(evaluation.scenarios) &&
    evaluation.scenarios.length < 2
  ) {
    warnings.push(
      "prefer at least a happy path and a negative-control scenario",
    );
  }
  return warnings;
}

async function main(): Promise<void> {
  const envPath = process.argv[2];
  if (!envPath || envPath === "--help" || envPath === "-h") {
    console.error("Usage: bun validate-mod-env.ts path/to/env.json");
    process.exit(envPath ? 0 : 1);
  }

  const env = JSON.parse(await readFile(envPath, "utf8"));
  const warnings = validateEnv(env);
  console.log(`OK ${envPath}`);
  for (const warning of warnings) console.warn(`warning: ${warning}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
