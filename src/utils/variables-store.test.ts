import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testOverrideVariablesRequest,
  deleteVariableOnServer,
  ensureVariablesLoaded,
  loadVariables,
  refreshAndListVariables,
  setVariableOnServer,
} from "./variables-store";

afterEach(() => __testOverrideVariablesRequest(null));

describe("agent variables", () => {
  test("old server 404 is cached as no variables; other errors propagate", async () => {
    let calls = 0;
    __testOverrideVariablesRequest(async () => {
      calls++;
      throw { status: 404 };
    });
    expect(await refreshAndListVariables("agent-old")).toEqual([]);
    await ensureVariablesLoaded("agent-old");
    expect(calls).toBe(1);
    expect(loadVariables("agent-old")).toEqual({});
    __testOverrideVariablesRequest(async () => {
      throw { status: 403 };
    });
    await expect(refreshAndListVariables("agent-old")).rejects.toEqual({
      status: 403,
    });
  });

  test("local variables persist per agent as plain JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "letta-variables-"));
    const previous = process.env.LETTA_LOCAL_BACKEND_DIR;
    process.env.LETTA_LOCAL_BACKEND_DIR = root;
    try {
      await setVariableOnServer(
        "USERNAME",
        "example-user",
        "agent-local-variables",
      );
      expect(
        JSON.parse(
          readFileSync(
            join(root, "variables-agent-local-variables.json"),
            "utf8",
          ),
        ),
      ).toEqual({ USERNAME: "example-user" });
      expect(await refreshAndListVariables("agent-local-other")).toEqual([]);
      expect(await refreshAndListVariables("agent-local-variables")).toEqual([
        { key: "USERNAME", value: "example-user" },
      ]);
      await deleteVariableOnServer("USERNAME", "agent-local-variables");
      expect(await refreshAndListVariables("agent-local-variables")).toEqual(
        [],
      );
    } finally {
      if (previous === undefined) delete process.env.LETTA_LOCAL_BACKEND_DIR;
      else process.env.LETTA_LOCAL_BACKEND_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
