import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import { buildModInvocationContext } from "@/mods/context";
import { settingsManager } from "@/settings-manager";
import { Input } from "./InputRich";

/**
 * Idle Esc must reach the interrupt handler when a background task's remote
 * stop failed (the handler retries the stop through the restored row), and
 * must keep its current fallthrough behavior when no stop failed.
 */
const ESC = "\u001b";

class NullOutput extends Writable {
  columns = 100;
  rows = 30;
  isTTY = true;

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback();
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function mountIdleInput(hasStopFailedTasks: boolean) {
  const interrupts: number[] = [];
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const instance = render(
    <Input
      streaming={false}
      tokenCount={0}
      thinkingMessage=""
      terminalWidth={100}
      shouldAnimate={false}
      interruptRequested={false}
      hasStopFailedTasks={hasStopFailedTasks}
      onInterrupt={() => {
        interrupts.push(interrupts.length);
      }}
      onSubmit={async () => ({ submitted: true })}
      modContext={buildModInvocationContext({
        agent: { id: "agent-stop-failed" },
      })}
      modAdapter={
        {
          hadModPanels: false,
          hasModSources: false,
          isLoading: false,
        } as unknown as LocalModAdapter
      }
    />,
    {
      stdin,
      stdout: new NullOutput() as NullOutput & NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  return {
    interrupts,
    async pressEsc() {
      await tick();
      stdin.push(ESC);
      await tick();
    },
    unmount() {
      instance.unmount();
      instance.cleanup();
    },
  };
}

let previousHome: string | undefined;
let tempHome: string;

beforeAll(async () => {
  previousHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "letta-input-stop-failed-"));
  process.env.HOME = tempHome;
  await settingsManager.reset();
  await settingsManager.initialize();
});

afterAll(() => {
  process.env.HOME = previousHome;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("InputRich idle Esc with a stop-failed background task", () => {
  test("forwards idle Esc to the interrupt handler to retry the stop", async () => {
    const input = mountIdleInput(true);
    await input.pressEsc();
    expect(input.interrupts.length).toBe(1);
    input.unmount();
  });

  test("keeps idle Esc as a no-op interrupt when no stop failed", async () => {
    const input = mountIdleInput(false);
    await input.pressEsc();
    expect(input.interrupts.length).toBe(0);
    input.unmount();
  });
});
