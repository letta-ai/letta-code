import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import {
  allocateImage,
  allocatePaste,
  buildMessageContentFromDisplay,
  getImage,
} from "@/cli/helpers/paste-registry";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import { buildModInvocationContext } from "@/mods/context";
import { settingsManager } from "@/settings-manager";
import { Input } from "./InputRich";

/**
 * Drives the real composer. Edits must not free paste-registry entries: the
 * text input's kill buffer (Ctrl+K / Ctrl+U, then Ctrl+Y) or a retyped bracket
 * brings a removed placeholder back, and the submitted text must still resolve.
 */
const CTRL_A = "\u0001";
const CTRL_C = "\u0003";
const CTRL_K = "\u000b";
const CTRL_Y = "\u0019";
const BACKSPACE = "\u007f";
const ENTER = "\r";

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

type ContentParts = ReturnType<typeof buildMessageContentFromDisplay>;

function mountComposer() {
  // Content is built from the display text when the submit handler runs.
  const submissions: ContentParts[] = [];
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
      onSubmit={async (message) => {
        submissions.push(buildMessageContentFromDisplay(message ?? ""));
        return { submitted: true };
      }}
      modContext={buildModInvocationContext({ agent: { id: "agent-draft" } })}
      // Input reads only the registry and load flags from the adapter.
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
    submissions,
    // One stdin read per key, each in its own tick, like a person typing.
    async press(...keys: string[]) {
      await tick();
      for (const key of keys) {
        stdin.push(key);
        await tick();
      }
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
  tempHome = mkdtempSync(join(tmpdir(), "letta-input-draft-placeholders-"));
  process.env.HOME = tempHome;
  await settingsManager.reset();
  await settingsManager.initialize();
});

afterAll(async () => {
  await settingsManager.reset();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("Input draft placeholders", () => {
  test("Ctrl+K then Ctrl+Y sends the yanked image, not a dangling placeholder", async () => {
    const id = allocateImage({ data: "iVBORw0KGgo=", mediaType: "image/png" });
    const composer = mountComposer();
    try {
      await composer.press(`[Image #${id}] tail`, CTRL_A, CTRL_K, CTRL_Y);
      await composer.press(ENTER);
    } finally {
      composer.unmount();
    }

    expect(composer.submissions).toHaveLength(1);
    expect(composer.submissions[0]?.map((part) => part.type)).toEqual([
      "image",
      "text",
    ]);
  });

  test("Backspace over ']' and retyping it still sends the pasted text", async () => {
    const content = Array.from({ length: 10 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const id = allocatePaste(content);
    const composer = mountComposer();
    try {
      await composer.press(`[Pasted text #${id} +10 lines]`, BACKSPACE, "]");
      await composer.press(ENTER);
    } finally {
      composer.unmount();
    }

    expect(composer.submissions).toEqual([[{ type: "text", text: content }]]);
  });

  test("a placeholder deleted from the draft is released when Ctrl+C clears it", async () => {
    const id = allocateImage({ data: "iVBORw0KGgo=", mediaType: "image/png" });
    const placeholder = `[Image #${id}]`;
    const composer = mountComposer();
    try {
      await composer.press(`keep ${placeholder}`);
      await composer.press(
        ...Array.from({ length: placeholder.length }, () => BACKSPACE),
      );
      // The edit alone keeps the entry: the placeholder could still come back.
      expect(getImage(id)).toBeDefined();

      await composer.press(CTRL_C);
      expect(getImage(id)).toBeUndefined();
    } finally {
      composer.unmount();
    }
    expect(composer.submissions).toHaveLength(0);
  });
});
