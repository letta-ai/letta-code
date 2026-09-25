import { describe, expect, test } from "bun:test";
import { requeueFailedEvents } from "@/telemetry/bounded-requeue";

describe("requeueFailedEvents", () => {
  test("re-queues failed events ahead of late arrivals in original order", () => {
    const queue = ["late1", "late2"];
    const dropped = requeueFailedEvents(queue, ["failed1", "failed2"], 10);
    expect(dropped).toBe(0);
    expect(queue).toEqual(["failed1", "failed2", "late1", "late2"]);
  });

  test("drops the oldest events when the re-queue would exceed the cap", () => {
    const queue = ["late1"];
    const dropped = requeueFailedEvents(
      queue,
      ["failed1", "failed2", "failed3"],
      3,
    );
    expect(dropped).toBe(1);
    expect(queue).toEqual(["failed2", "failed3", "late1"]);
  });

  test("trims an already-oversized queue down to the cap", () => {
    const queue = ["late1", "late2", "late3"];
    const dropped = requeueFailedEvents(queue, ["failed1", "failed2"], 2);
    expect(dropped).toBe(3);
    expect(queue).toEqual(["late2", "late3"]);
  });

  test("is a no-op when nothing failed", () => {
    const queue = ["pending1"];
    const dropped = requeueFailedEvents(queue, [], 1);
    expect(dropped).toBe(0);
    expect(queue).toEqual(["pending1"]);
  });
});
