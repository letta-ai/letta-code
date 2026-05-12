import { describe, expect, test } from "bun:test";
import { renderQrTerminal } from "../../channels/whatsapp/session";

describe("WhatsApp session", () => {
  test("renders qrcode-terminal with the module as this", () => {
    const qrMod = {
      error: "L",
      generate(
        this: { error?: string },
        input: string,
        options: unknown,
        cb?: (output: string) => void,
      ) {
        if (!this.error) {
          throw new Error("missing this binding");
        }
        cb?.(`${input}:${this.error}:${JSON.stringify(options)}`);
      },
    };

    expect(renderQrTerminal(qrMod, "pairing-payload")).toBe(
      'pairing-payload:L:{"small":true}',
    );
  });

  test("falls back when qrcode-terminal rendering throws", () => {
    const qrMod = {
      generate() {
        throw new Error("boom");
      },
    };

    expect(renderQrTerminal(qrMod, "pairing-payload")).toBeUndefined();
  });
});
