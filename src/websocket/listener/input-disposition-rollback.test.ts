import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  createAcceptedInputDispositionLedger,
  getInputDisposition,
  ordinaryInputIdentity,
  reserveInputDisposition,
} from "./input-disposition";
import { rollbackInputDisposition } from "./input-disposition-rollback";
import { createRuntime } from "./lifecycle";

test("an exact reservation whose durable rollback failed can be reclaimed", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-reclaim-"));
  try {
    const path = join(root, "state.json");
    const listener = createRuntime();
    listener.acceptedInputDispositionLedger =
      createAcceptedInputDispositionLedger({ persistentPath: path });
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-durable",
      "conversation-durable",
    );
    const identity = ordinaryInputIdentity("cm-reclaim");
    const first = reserveInputDisposition(runtime, identity);
    if (first.kind !== "reserved") throw new Error("expected reservation");
    const durableReservation = readFileSync(path, "utf8");

    rmSync(path);
    mkdirSync(path);
    expect(rollbackInputDisposition(runtime, first.reservation)).toBe(false);
    expect(
      listener.acceptedInputDispositionLedger.abandonedReservations.size,
    ).toBe(1);

    rmSync(path, { recursive: true });
    writeFileSync(path, durableReservation, { mode: 0o600 });
    const replacement = reserveInputDisposition(runtime, identity);
    expect(replacement.kind).toBe("reserved");
    if (replacement.kind !== "reserved") return;
    expect(replacement.reservation.token).not.toBe(first.reservation.token);
    expect(
      listener.acceptedInputDispositionLedger.abandonedReservations.size,
    ).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable synchronization bounds abandoned reservation metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-bound-"));
  try {
    const path = join(root, "state.json");
    const listener = createRuntime();
    listener.acceptedInputDispositionLedger =
      createAcceptedInputDispositionLedger({ persistentPath: path });
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-durable",
      "conversation-durable",
    );

    for (let index = 0; index < 128; index += 1) {
      const identity = ordinaryInputIdentity(`cm-stale-${index}`);
      const admission = reserveInputDisposition(runtime, identity);
      if (admission.kind !== "reserved")
        throw new Error("expected reservation");
      const durableReservation = readFileSync(path, "utf8");
      rmSync(path);
      mkdirSync(path);
      expect(rollbackInputDisposition(runtime, admission.reservation)).toBe(
        false,
      );
      rmSync(path, { recursive: true });
      writeFileSync(path, durableReservation, { mode: 0o600 });

      const durable = JSON.parse(durableReservation) as {
        reservations: Record<string, unknown>;
      };
      durable.reservations = {};
      writeFileSync(path, JSON.stringify(durable), { mode: 0o600 });
      getInputDisposition(runtime, ordinaryInputIdentity("cm-sync"));
      expect(
        listener.acceptedInputDispositionLedger.abandonedReservations.size,
      ).toBe(0);
    }

    const identity = ordinaryInputIdentity("cm-recent");
    const admission = reserveInputDisposition(runtime, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    const durableReservation = readFileSync(path, "utf8");
    rmSync(path);
    mkdirSync(path);
    expect(rollbackInputDisposition(runtime, admission.reservation)).toBe(
      false,
    );
    rmSync(path, { recursive: true });
    writeFileSync(path, durableReservation, { mode: 0o600 });

    getInputDisposition(runtime, ordinaryInputIdentity("cm-sync"));
    expect(
      listener.acceptedInputDispositionLedger.abandonedReservations.get(
        admission.reservation.key,
      ),
    ).toEqual({
      token: admission.reservation.token,
      generation: admission.reservation.generation,
    });
    expect(reserveInputDisposition(runtime, identity).kind).toBe("reserved");
    expect(
      listener.acceptedInputDispositionLedger.abandonedReservations.size,
    ).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
