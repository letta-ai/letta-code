import { describe, expect, test } from "bun:test";
import {
  type ChannelFailureContainmentTarget,
  installChannelFailureContainment,
} from "@/cli/subcommands/channel-gateway";

function createTarget() {
  const handlers = new Map<string, (value: never) => void>();
  const target: ChannelFailureContainmentTarget = {
    on(event: string, listener: (value: never) => void) {
      handlers.set(event, listener);
      return target;
    },
  } as ChannelFailureContainmentTarget;
  return { target, handlers };
}

describe("installChannelFailureContainment", () => {
  test("registers handlers for both escape routes", () => {
    const { target, handlers } = createTarget();

    installChannelFailureContainment(target, () => {});

    expect([...handlers.keys()].sort()).toEqual([
      "uncaughtException",
      "unhandledRejection",
    ]);
  });

  test("reports an uncaught adapter failure instead of rethrowing", () => {
    const { target, handlers } = createTarget();
    const logged: string[] = [];

    installChannelFailureContainment(target, (message) => {
      logged.push(message);
    });
    const error = new Error("An API error occurred: invalid_auth");
    // The gateway must survive this — an unkillable restart loop is what a
    // revoked channel credential used to cause.
    expect(() => {
      handlers.get("uncaughtException")?.(error as never);
    }).not.toThrow();

    expect(logged[0]).toBe(
      "[ChannelGateway] contained uncaughtException: An API error occurred: invalid_auth",
    );
  });

  test("reports a rejection whose reason is not an Error", () => {
    const { target, handlers } = createTarget();
    const logged: string[] = [];

    installChannelFailureContainment(target, (message) => {
      logged.push(message);
    });
    handlers.get("unhandledRejection")?.("socket closed" as never);

    expect(logged).toEqual([
      "[ChannelGateway] contained unhandledRejection: socket closed",
    ]);
  });
});
