import { expect, test } from "bun:test";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import { createConversationRuntime } from "./runtime";
import { assertRuntimeWorkspaceSandboxChangeAllowed } from "./runtime-workspace-sandbox";

test("rejects changing the workspace sandbox on an active runtime", () => {
  const listener = __listenClientTestUtils.createListenerRuntime();
  const runtime = createConversationRuntime(listener, "agent-1", "conv-1");
  runtime.workspaceSandbox = {
    root: "/tmp/runs/run-a",
    isolationRoot: "/tmp/runs",
  };
  listener.connectionIdsByRuntimeKey.set(runtime.key, new Set(["sdk-1"]));

  expect(() =>
    assertRuntimeWorkspaceSandboxChangeAllowed(listener, runtime, {
      root: "/tmp/runs/run-b",
      isolationRoot: "/tmp/runs",
    }),
  ).toThrow(
    "runtime_start cannot change the workspace sandbox for an active runtime",
  );
  expect(() =>
    assertRuntimeWorkspaceSandboxChangeAllowed(
      listener,
      runtime,
      runtime.workspaceSandbox,
    ),
  ).not.toThrow();
});
