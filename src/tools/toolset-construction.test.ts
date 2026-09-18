import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { toolFilter } from "./filter";
import {
  clearCapturedToolExecutionContexts,
  clearTools,
  executeTool,
  getClientToolsFromRegistry,
  loadSpecificTools,
  prepareToolExecutionContextForModel,
  prepareToolExecutionContextForSpecificTools,
} from "./manager";
import {
  forceToolsetSwitch,
  loadStartupTools,
  prepareToolExecutionContextForResolvedTarget as prepare,
  switchToolsetForModel,
} from "./toolset";
import { TOOLSET_OPTIONS } from "./toolset-catalog";

const originalArtifacts = process.env.LETTA_ARTIFACTS;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  clearCapturedToolExecutionContexts();
  clearTools();
  toolFilter.reset();
  __testSetBackend(null);
  if (originalArtifacts === undefined) delete process.env.LETTA_ARTIFACTS;
  else process.env.LETTA_ARTIFACTS = originalArtifacts;
  for (const path of temporaryDirectories.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("shared toolset construction", () => {
  for (const { id } of TOOLSET_OPTIONS) {
    if (id === "auto") continue;
    test(`${id}: startup, switching, and turn preparation produce identical payloads`, async () => {
      __testSetBackend(new FakeHeadlessBackend());
      await loadStartupTools({ toolset: id });
      const startupTools = getClientToolsFromRegistry();
      await loadSpecificTools(["Read"]);
      await forceToolsetSwitch(id);
      expect(getClientToolsFromRegistry()).toEqual(startupTools);
      const turn = await prepare({ toolsetPreference: id });
      expect(turn.preparedToolContext.clientTools).toEqual(startupTools);
    });
  }

  for (const model of [
    "anthropic/claude-sonnet-4",
    "openai/gpt-5.6-sol",
    "google_ai/gemini-3.1-pro-preview",
  ]) {
    test(`${model}: auto and its explicit preset produce identical payloads`, async () => {
      __testSetBackend(new FakeHeadlessBackend());
      const auto = await prepare({
        toolsetPreference: "auto",
        modelIdentifier: model,
      });
      const explicit = await prepare({
        toolsetPreference: auto.toolset,
        modelIdentifier: model,
      });
      expect(auto.preparedToolContext.clientTools).toEqual(
        explicit.preparedToolContext.clientTools,
      );
      await loadStartupTools({ toolset: "auto", modelIdentifier: model });
      expect(getClientToolsFromRegistry()).toEqual(
        auto.preparedToolContext.clientTools,
      );
      expect(await switchToolsetForModel(model)).toBe(auto.toolset);
      expect(getClientToolsFromRegistry()).toEqual(
        auto.preparedToolContext.clientTools,
      );
    });
  }

  test("manual and explicit-list builders describe subagents from the turn's working directory", async () => {
    const workingDirectory = await mkdtemp(
      join(tmpdir(), "letta-toolset-agents-"),
    );
    temporaryDirectories.push(workingDirectory);
    await mkdir(join(workingDirectory, ".letta", "agents"), {
      recursive: true,
    });
    await writeFile(
      join(workingDirectory, ".letta", "agents", "toolset-auditor.md"),
      "---\nname: toolset-auditor\ndescription: Inspect toolset assembly\nmodel: anthropic/claude-sonnet-4\ntools: Read\n---\nInspect tools.\n",
    );
    const manual = await prepare({
      toolsetPreference: "letta",
      workingDirectory,
    });
    const explicit = await prepareToolExecutionContextForSpecificTools(
      ["Task"],
      { workingDirectory },
    );
    for (const tools of [
      manual.preparedToolContext.clientTools,
      explicit.clientTools,
    ]) {
      const description = tools.find(
        (tool) => tool.name === "Agent",
      )?.description;
      expect(description).toContain("## Available Agents");
      expect(description).toContain("### toolset-auditor");
      expect(description).toContain("Inspect toolset assembly");
    }
    const other = await prepare({ toolsetPreference: "letta" });
    expect(
      other.preparedToolContext.clientTools.find(
        (tool) => tool.name === "Agent",
      )?.description,
    ).not.toContain("### toolset-auditor");
  });

  test("explicit exclusions win over enabled artifact tools for auto and manual presets", async () => {
    process.env.LETTA_ARTIFACTS = "1";
    const exclude = ["read_artifact_file", "write_artifact_file"] as const;
    for (const toolsetPreference of [
      "auto",
      "default",
      "letta",
      "codex",
    ] as const) {
      const enabled = await prepare({ toolsetPreference });
      expect(enabled.preparedToolContext.loadedToolNames).toContain(
        "read_artifact_file",
      );
      const excluded = await prepare({
        toolsetPreference,
        exclude: [...exclude],
      });
      expect(excluded.preparedToolContext.loadedToolNames).not.toContain(
        "read_artifact_file",
      );
      expect(excluded.preparedToolContext.loadedToolNames).not.toContain(
        "write_artifact_file",
      );
      await loadStartupTools({
        toolset: toolsetPreference,
        exclude: [...exclude],
      });
      expect(getClientToolsFromRegistry()).toEqual(
        excluded.preparedToolContext.clientTools,
      );
    }
  });

  test("session filters accept model-facing names and load requested tools outside every preset", async () => {
    toolFilter.setEnabledTools("Agent,Grep");
    for (const toolsetPreference of [
      "auto",
      "default",
      "codex",
      "letta",
      "none",
    ] as const) {
      const prepared = await prepare({ toolsetPreference });
      expect(prepared.preparedToolContext.loadedToolNames).toEqual([
        "Agent",
        "Grep",
      ]);
      await loadStartupTools({ toolset: toolsetPreference });
      expect(getClientToolsFromRegistry()).toEqual(
        prepared.preparedToolContext.clientTools,
      );
    }
  });
  test("loads model-derived client tools by request-scoped allowlist", async () => {
    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      { clientToolAllowlist: ["Read", "Grep", "Glob"] },
    );

    expect(prepared.loadedToolNames).toEqual(["Read", "Grep", "Glob"]);
    expect(prepared.clientTools.map((tool) => tool.name)).toEqual(
      prepared.loadedToolNames,
    );
    expect(prepared.loadedToolNames).not.toContain("Bash");

    const denied = await executeTool(
      "Bash",
      { command: "echo no", description: "Print no" },
      { toolContextId: prepared.contextId },
    );
    expect(denied.status).toBe("error");
    expect(denied.toolReturn).toContain("Tool not found: Bash");
  });
});
