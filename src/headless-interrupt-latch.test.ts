import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decideInterruptAction } from "@/headless";

describe("decideInterruptAction", () => {
  test("aborts the active turn when a controller exists", () => {
    expect(
      decideInterruptAction({ hasActiveController: true, turnStarting: false }),
    ).toBe("abort-active");
    // An active controller takes precedence even mid-startup.
    expect(
      decideInterruptAction({ hasActiveController: true, turnStarting: true }),
    ).toBe("abort-active");
  });

  test("latches when a turn is starting but its controller does not exist yet", () => {
    // Narrow pre-controller race: a user message was just dispatched.
    expect(
      decideInterruptAction({ hasActiveController: false, turnStarting: true }),
    ).toBe("latch");
  });

  test("is a no-op when idle (no active or starting turn)", () => {
    // The regression: an idle interrupt must NOT latch, or it poisons the
    // next user turn.
    expect(
      decideInterruptAction({
        hasActiveController: false,
        turnStarting: false,
      }),
    ).toBe("noop");
  });
});

/**
 * Lifecycle simulation mirroring the headless main loop's interrupt handling,
 * driven purely by decideInterruptAction. Proves the two behaviors cpacker
 * asked us to cover in PR #2631:
 *   1. an idle interrupt does not abort the next user message
 *   2. an interrupt immediately after a user message still aborts that turn
 */
class TurnSim {
  hasActiveController = false;
  turnStarting = false;
  pendingInterrupt = false;
  aborted = false;

  /** A user message is handed to the (idle) main loop. */
  dispatchUserMessage() {
    this.turnStarting = true;
  }

  /** An incoming control_request:interrupt, handled by the fast path. */
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
    // "noop": respond success, change nothing.
  }

  /** The main loop creates the AbortController for the dispatched turn. */
  createController() {
    this.hasActiveController = true;
    if (this.pendingInterrupt) {
      this.pendingInterrupt = false;
      this.aborted = true;
    }
    this.turnStarting = false;
  }

  /** The turn finishes and the loop returns to idle. */
  endTurn() {
    this.hasActiveController = false;
    this.aborted = false;
  }
}

describe("headless interrupt latch lifecycle", () => {
  test("idle interrupt does not abort the next user message", () => {
    const sim = new TurnSim();

    // Interrupt arrives while idle (no turn running or starting).
    sim.interrupt();
    expect(sim.pendingInterrupt).toBe(false);

    // A later, unrelated user message must run normally.
    sim.dispatchUserMessage();
    sim.createController();
    expect(sim.aborted).toBe(false);
  });

  test("interrupt immediately after a user message still aborts that turn", () => {
    const sim = new TurnSim();

    // User message dispatched, then interrupt arrives in the same stdin burst
    // before the controller is created.
    sim.dispatchUserMessage();
    sim.interrupt();
    expect(sim.pendingInterrupt).toBe(true);

    // The imminent turn aborts via the drained latch.
    sim.createController();
    expect(sim.aborted).toBe(true);
  });

  test("idle interrupt then a turn then another idle interrupt stays clean", () => {
    const sim = new TurnSim();

    sim.interrupt(); // idle: noop
    sim.dispatchUserMessage();
    sim.createController();
    expect(sim.aborted).toBe(false);
    sim.endTurn();

    sim.interrupt(); // idle again: noop
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

    // The fast path routes through the shared decision function.
    expect(source).toContain("decideInterruptAction({");
    // turnStarting is opened only for user-message delivery...
    expect(source).toContain(
      'if (parsedLine?.type === "user") turnStarting = true;',
    );
    // ...and closed once the controller exists.
    expect(source).toContain(
      "// Controller now exists — close the pre-controller race window.",
    );
  });
});
