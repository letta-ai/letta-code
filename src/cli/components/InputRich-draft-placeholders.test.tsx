import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import { useState } from "react";
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

const CTRL_A = "\u0001";
const CTRL_C = "\u0003";
const CTRL_K = "\u000b";
const CTRL_Y = "\u0019";
const BACKSPACE = "\u007f";
const ENTER = "\r";
const UP = "\u001b[A";
const DOWN = "\u001b[B";

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
  const submissions: ContentParts[] = [];
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  let setRestoredInput: (text: string | null) => void = () => {};
  function Composer() {
    const [restoredInput, setRestored] = useState<string | null>(null);
    setRestoredInput = setRestored;
    return (
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
        restoredInput={restoredInput}
        onRestoredInputConsumed={() => setRestored(null)}
        modContext={buildModInvocationContext({
          agent: { id: "agent-draft" },
        })}
        modAdapter={
          {
            hadModPanels: false,
            hasModSources: false,
            isLoading: false,
          } as unknown as LocalModAdapter
        }
      />
    );
  }
  const instance = render(<Composer />, {
    stdin,
    stdout: new NullOutput() as NullOutput & NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    submissions,
    async press(...keys: string[]) {
      await tick();
      for (const key of keys) {
        stdin.push(key);
        await tick();
      }
    },
    async restore(text: string) {
      setRestoredInput(text);
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
      expect(getImage(id)).toBeDefined();

      await composer.press(CTRL_C);
      expect(getImage(id)).toBeUndefined();
    } finally {
      composer.unmount();
    }
    expect(composer.submissions).toHaveLength(0);
  });
});

describe("Input draft holders", () => {
  test("typing into a recalled entry drops the parked draft; Ctrl+C leaves its image freed", async () => {
    const id = allocateImage({ data: "iVBORw0KGgo=", mediaType: "image/png" });
    const composer = mountComposer();
    try {
      await composer.press("hello", ENTER, `[Image #${id}]`, UP, UP);
      expect(getImage(id)).toBeDefined();

      await composer.press("x", CTRL_C);
      expect(getImage(id)).toBeUndefined();
    } finally {
      composer.unmount();
    }
  });

  test("re-sending a recalled entry frees the parked draft's image", async () => {
    const id = allocateImage({ data: "iVBORw0KGgo=", mediaType: "image/png" });
    const composer = mountComposer();
    try {
      await composer.press("hello", ENTER, `[Image #${id}]`, UP, UP, ENTER);
      expect(getImage(id)).toBeUndefined();
    } finally {
      composer.unmount();
    }
    const hello: ContentParts = [{ type: "text", text: "hello" }];
    expect(composer.submissions).toEqual([hello, hello]);
  });

  test("Ctrl+C while browsing history frees the parked draft's image", async () => {
    const id = allocateImage({ data: "iVBORw0KGgo=", mediaType: "image/png" });
    const composer = mountComposer();
    try {
      await composer.press("hello", ENTER, `[Image #${id}]`, UP, UP, CTRL_C);
      expect(getImage(id)).toBeUndefined();
    } finally {
      composer.unmount();
    }
  });

  test("Down restores the parked draft; deleting it and Ctrl+C frees the image", async () => {
    const id = allocateImage({ data: "iVBORw0KGgo=", mediaType: "image/png" });
    const placeholder = `[Image #${id}]`;
    const composer = mountComposer();
    try {
      await composer.press("hello", ENTER, placeholder, UP, UP, DOWN);
      await composer.press(
        ...Array.from({ length: placeholder.length }, () => BACKSPACE),
      );
      expect(getImage(id)).toBeDefined();

      await composer.press(CTRL_C);
      expect(getImage(id)).toBeUndefined();
    } finally {
      composer.unmount();
    }
  });

  test("Ctrl+K, Up, Down, Ctrl+Y still sends the yanked image", async () => {
    const id = allocateImage({ data: "iVBORw0KGgo=", mediaType: "image/png" });
    const composer = mountComposer();
    try {
      await composer.press("hello", ENTER, `[Image #${id}] tail`, CTRL_A);
      await composer.press(CTRL_K, UP, DOWN, CTRL_Y, ENTER);
    } finally {
      composer.unmount();
    }
    expect(composer.submissions[1]?.map((part) => part.type)).toEqual([
      "image",
      "text",
    ]);
  });

  test("a restored input dropped because the composer has text is released", async () => {
    const id = allocateImage({ data: "iVBORw0KGgo=", mediaType: "image/png" });
    const composer = mountComposer();
    try {
      await composer.press("draft");
      await composer.restore(`[Image #${id}] retry`);
      expect(getImage(id)).toBeUndefined();

      await composer.press(ENTER);
    } finally {
      composer.unmount();
    }
    expect(composer.submissions).toEqual([[{ type: "text", text: "draft" }]]);
  });
});
