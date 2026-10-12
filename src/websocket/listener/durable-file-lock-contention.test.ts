import { expect, test } from "bun:test";
import {
  linkSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDurableFileLock } from "./durable-file-lock";

test("removing the installation link after a reader lists it retries the live owner", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-lock-publication-"));
  const path = join(root, "ledger");
  let removed = false;
  try {
    const release = acquireDurableFileLock(path, {
      afterCanonicalOwnerLink(lockPath) {
        const stableName = readdirSync(lockPath).find(
          (name) => name !== ".installing",
        );
        if (!stableName) throw new Error("Missing published lock owner");
        let clock = 0;
        try {
          // Pause publication with both real hard links present, then remove
          // the temporary link after the contender has listed both names.
          expect(() =>
            acquireDurableFileLock(path, {
              waitMs: 50,
              now: () => clock,
              afterOwnerDirectoryRead(directory) {
                if (removed) return;
                unlinkSync(join(directory, ".installing"));
                removed = true;
                clock = 51;
              },
            }),
          ).toThrow("Timed out acquiring durable filesystem lock");
        } finally {
          if (removed)
            linkSync(join(lockPath, stableName), join(lockPath, ".installing"));
        }
      },
    });
    release();
    expect(removed).toBe(true);
    acquireDurableFileLock(path)();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
