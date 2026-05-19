import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireWhatsAppSessionLease,
  renderQrTerminal,
} from "../../channels/whatsapp/session";

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

  test("prevents concurrent session leases for the same account", () => {
    const root = join(
      tmpdir(),
      `letta-whatsapp-session-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(root, { recursive: true });
    const lockDir = join(root, "lock");

    try {
      const lease = acquireWhatsAppSessionLease("test-account", { lockDir });
      expect(() =>
        acquireWhatsAppSessionLease("test-account", { lockDir }),
      ).toThrow(/already has an active session/);

      lease.release();
      const reacquired = acquireWhatsAppSessionLease("test-account", {
        lockDir,
      });
      reacquired.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removes stale session leases", () => {
    const root = join(
      tmpdir(),
      `letta-whatsapp-session-stale-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(root, { recursive: true });
    const lockDir = join(root, "lock");
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 12345, command: "old server" }),
    );

    try {
      const lease = acquireWhatsAppSessionLease("stale-account", {
        lockDir,
        isProcessAlive: () => false,
      });
      lease.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
