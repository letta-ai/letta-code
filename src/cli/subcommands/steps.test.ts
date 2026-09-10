import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type {
  ProviderTrace,
  Step,
} from "@letta-ai/letta-client/resources/steps/steps";
import { isReadOnlyShellCommand } from "@/permissions/read-only-shell";
import { runStepsSubcommand } from "./steps";

const step: Step = {
  id: "step-1",
  agent_id: "agent-target",
  error_type: "provider_error",
  total_tokens: 200,
};
const trace: ProviderTrace = {
  agent_id: "agent-target",
  step_id: "step-1",
  request_json: { messages: [{ role: "user", content: "incident" }] },
  response_json: { error: "failed" },
};
const initialize = mock(async () => {});
const retrieveStep = mock(async (): Promise<Step> => step);
const retrieveTrace = mock(async (): Promise<ProviderTrace | null> => trace);
const argv = ["trace", "--agent", "agent-target", "--step", "step-1"];
let stdout: string[];
let stderr: string[];
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  stdout = [];
  stderr = [];
  logSpy = spyOn(console, "log").mockImplementation((value) => {
    stdout.push(String(value));
  });
  errorSpy = spyOn(console, "error").mockImplementation((value) => {
    stderr.push(String(value));
  });
  initialize.mockClear();
  retrieveStep.mockReset();
  retrieveStep.mockImplementation(async () => step);
  retrieveTrace.mockReset();
  retrieveTrace.mockImplementation(async () => trace);
});
afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

function run(args = argv, local = false) {
  return runStepsSubcommand(args, {
    initialize,
    retrieveStep,
    retrieveTrace,
    isLocal: () => local,
  });
}

test("returns step metadata and the unchanged captured request/response", async () => {
  expect(await run()).toBe(0);
  expect(JSON.parse(stdout[0] ?? "")).toEqual({
    status: "available",
    step,
    trace,
  });
  expect(retrieveStep).toHaveBeenCalledWith("step-1");
  expect(retrieveTrace).toHaveBeenCalledWith("step-1");
});

test("missing trace preserves step metadata without inventing a cause", async () => {
  retrieveTrace.mockResolvedValueOnce(null);
  expect(await run()).toBe(0);
  expect(JSON.parse(stdout[0] ?? "")).toEqual({
    status: "unavailable",
    step,
    trace: null,
  });
});

test("local backend reports unsupported without contacting the API", async () => {
  expect(await run(argv, true)).toBe(0);
  expect(JSON.parse(stdout[0] ?? "").status).toBe("unsupported");
  expect(retrieveStep).not.toHaveBeenCalled();
  expect(retrieveTrace).not.toHaveBeenCalled();
});

test("rejects a step from another agent before retrieving its trace", async () => {
  retrieveStep.mockResolvedValueOnce({ ...step, agent_id: "other-agent" });
  expect(await run()).toBe(1);
  expect(stdout).toEqual([]);
  expect(retrieveTrace).not.toHaveBeenCalled();
});

test.each([{ agent_id: "other-agent" }, { step_id: "other-step" }])(
  "rejects mismatched trace identifiers %j",
  async (mismatch) => {
    retrieveTrace.mockResolvedValueOnce({ ...trace, ...mismatch });
    expect(await run()).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("does not match");
  },
);

test("API/auth failures are errors, not unavailable evidence", async () => {
  retrieveTrace.mockRejectedValueOnce(new Error("401 Unauthorized"));
  expect(await run()).toBe(1);
  expect(stdout).toEqual([]);
  expect(stderr.join("\n")).toContain("401 Unauthorized");
});

test("requires an explicit target even when a current agent is in the environment", async () => {
  expect(await run(["trace", "--step", "step-1"])).toBe(1);
  expect(initialize).not.toHaveBeenCalled();
});

test("help works without initializing authentication", async () => {
  expect(await run(["--help"])).toBe(0);
  expect(stdout.join("\n")).toContain("letta steps trace");
  expect(initialize).not.toHaveBeenCalled();
});

test("trace retrieval is classified as read only without allowing arbitrary steps commands", () => {
  expect(
    isReadOnlyShellCommand(
      "letta steps trace --agent agent-target --step step-1",
    ),
  ).toBe(true);
  expect(isReadOnlyShellCommand("letta steps delete --step step-1")).toBe(
    false,
  );
});
