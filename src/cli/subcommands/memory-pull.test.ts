import { describe, expect, mock, test } from "bun:test";
import { prepareMemoryPull } from "@/cli/subcommands/memory";

describe("memory pull checkout materialization", () => {
  test("clones a missing Cloud checkout", async () => {
    const clone = mock(async (_agentId: string) => {});
    const initializeCloudSettings = mock(async () => {});

    await expect(
      prepareMemoryPull("agent-cloud-source", {
        hasCheckout: false,
        isLocalBackend: false,
        clone,
        initializeCloudSettings,
      }),
    ).resolves.toEqual({ checkout: "cloned", localBackend: false });
    expect(initializeCloudSettings).toHaveBeenCalledTimes(1);
    expect(clone).toHaveBeenCalledTimes(1);
    expect(clone.mock.calls[0]).toEqual(["agent-cloud-source"]);
  });

  test("does not recreate a missing local checkout", async () => {
    const clone = mock(async (_agentId: string) => {});
    const initializeCloudSettings = mock(async () => {});

    await expect(
      prepareMemoryPull("agent-local-source", {
        hasCheckout: false,
        isLocalBackend: true,
        clone,
        initializeCloudSettings,
      }),
    ).resolves.toEqual({ checkout: "missing-local", localBackend: true });
    expect(initializeCloudSettings).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
  });

  test("leaves an existing checkout alone", async () => {
    const clone = mock(async (_agentId: string) => {});
    const initializeCloudSettings = mock(async () => {});

    await expect(
      prepareMemoryPull("agent-source", {
        hasCheckout: true,
        isLocalBackend: false,
        clone,
        initializeCloudSettings,
      }),
    ).resolves.toEqual({ checkout: "existing", localBackend: false });
    expect(initializeCloudSettings).toHaveBeenCalledTimes(1);
    expect(clone).not.toHaveBeenCalled();
  });
});
