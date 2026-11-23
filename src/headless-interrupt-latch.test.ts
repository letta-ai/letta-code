import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decideInterruptAction } from "@/headless";

describe("decideInterruptAction", () => {
  test("aborts the active turn when a controller exists", () => {
    expect(
      decideInterruptAction({ hasActiveController: true, turnStarting: false }),
    ).toBe("abort-active");
    expect(
      decideInterruptAction({ hasActiveController: true, turnStarting: true }),
    ).toBe("abort-active");
  });

  test("latches when a turn is starting but its controller does not exist yet", () => {
    expect(
      decideInterruptAction({ hasActiveController: false, turnStarting: true }),
    ).toBe("latch");
  });

  test("is a no-op when idle (no active or starting turn)", () => {
    expect(
      decideInterruptAction({
        hasActiveController: false,
        turnStarting: false,
      }),
    ).toBe("noop");
  });
});

class TurnSim {
  hasActiveController = false;
  turnStarting = false;
  pendingInterrupt = false;
  aborted = false;

  dispatchUserMessage() {
    this.turnStarting = true;
  }

  interrupt() {
    const action = decideInterruptAction({
      hasActiveController: this.hasActiveController,
      turnStarting: this.turnStarting,
    });
    if (action === "abort-active") {
      this.aborted = true;
    } else if (action === "latch") {
      this.pendingInterrupt = true;
    }
  }

  createController() {
    this.hasActiveController = true;
    if (this.pendingInterrupt) {
      this.pendingInterrupt = false;
      this.aborted = true;
    }
    this.turnStarting = false;
  }

  endTurn() {
    this.hasActiveController = false;
    this.aborted = false;
  }
}

describe("headless interrupt latch lifecycle", () => {
  test("idle interrupt does not abort the next user message", () => {
    const sim = new TurnSim();

    sim.interrupt();
    expect(sim.pendingInterrupt).toBe(false);

    sim.dispatchUserMessage();
    sim.createController();
    expect(sim.aborted).toBe(false);
  });

  test("interrupt immediately after a user message still aborts that turn", () => {
    const sim = new TurnSim();

    sim.dispatchUserMessage();
    sim.interrupt();
    expect(sim.pendingInterrupt).toBe(true);

    sim.createController();
    expect(sim.aborted).toBe(true);
  });

  test("idle interrupt then a turn then another idle interrupt stays clean", () => {
    const sim = new TurnSim();

    sim.interrupt();
    sim.dispatchUserMessage();
    sim.createController();
    expect(sim.aborted).toBe(false);
    sim.endTurn();

    sim.interrupt();
    sim.dispatchUserMessage();
    sim.createController();
    expect(sim.aborted).toBe(false);
  });
});

describe("headless interrupt latch wiring", () => {
  test("source gates the latch on turnStarting and closes the window after controller creation", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./headless.ts", import.meta.url)),
      "utf-8",
    );

    expect(source).toContain("decideInterruptAction({");
    expect(source).toContain(
      'if (parsedLine?.type === "user") turnStarting = true;',
    );
    expect(source).toContain(
      "turnStarting = false;\n      turnInProgress = true;",
    );
    expect(source).toContain(
      "const resolve = lineResolver;\n          lineResolver = null;\n          resolve(null);",
    );
  });
});
