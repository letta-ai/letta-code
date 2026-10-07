import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { render } from "ink";
import { useNestedToolApproval } from "./use-nested-tool-approval";

class Output extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;
  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: () => void,
  ) {
    callback();
  }
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}

function mountApproval() {
  const generation = { current: 1 };
  const conversation = { current: "conversation-1" };
  const toolContext = { current: "context-1" as string | null };
  let hook: ReturnType<typeof useNestedToolApproval> | undefined;
  function Harness() {
    hook = useNestedToolApproval(generation, conversation, toolContext);
    return null;
  }
  const output = new Output();
  const instance = render(<Harness />, {
    stdout: output as Output & NodeJS.WriteStream,
    stderr: output as Output & NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    generation,
    conversation,
    toolContext,
    get hook() {
      return hook;
    },
    close: () => {
      instance.unmount();
      instance.cleanup();
    },
  };
}

function currentHook(host: ReturnType<typeof mountApproval>) {
  const hook = host.hook;
  if (!hook) throw new Error("Nested approval hook was not mounted");
  return hook;
}

test("nested approval resolves only its own promise and advances queued prompts", async () => {
  const host = mountApproval();
  try {
    await waitFor(() => !!host.hook);
    const first = currentHook(host).requestApproval({
      toolName: "Bash",
      args: { command: "one" },
      toolCallId: "nested-1",
    });
    await waitFor(() => host.hook?.current?.approval.toolCallId === "nested-1");
    const second = currentHook(host).requestApproval({
      toolName: "Bash",
      args: { command: "two" },
      toolCallId: "nested-2",
      allowPersistence: false,
    });
    currentHook(host).decide(false);
    expect(await first).toEqual({ approved: false, args: undefined });
    await waitFor(() => host.hook?.current?.approval.toolCallId === "nested-2");
    expect(host.hook?.current?.context.allowPersistence).toBe(false);
    currentHook(host).decide(true);
    expect(await second).toEqual({ approved: true, args: { command: "two" } });
  } finally {
    host.close();
  }
});

test("abort and released tool context deny pending and late approvals", async () => {
  const host = mountApproval();
  try {
    await waitFor(() => !!host.hook);
    const controller = new AbortController();
    const aborted = currentHook(host).requestApproval({
      toolName: "Bash",
      args: { command: "one" },
      toolCallId: "nested-1",
      signal: controller.signal,
    });
    await waitFor(() => !!host.hook?.current);
    controller.abort();
    expect(await aborted).toEqual({ approved: false });
    await waitFor(() => !host.hook?.current);
    const released = currentHook(host).requestApproval({
      toolName: "Bash",
      args: { command: "two" },
      toolCallId: "nested-2",
    });
    await waitFor(() => !!host.hook?.current);
    host.toolContext.current = null;
    currentHook(host).decide(true);
    expect(await released).toEqual({ approved: false });
  } finally {
    host.close();
  }
});
