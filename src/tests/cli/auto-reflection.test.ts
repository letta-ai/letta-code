import { afterEach, describe, expect, test } from "bun:test";
import { __autoReflectionTestUtils } from "../../cli/helpers/autoReflection";

describe("auto reflection launcher serialization", () => {
  afterEach(() => {
    __autoReflectionTestUtils.resetReflectionQueue();
  });

  test("serializes reflection work for the same parent agent", async () => {
    const events: string[] = [];
    let activeCount = 0;
    let maxActiveCount = 0;

    const makeLaunch = (id: string) => async () => {
      events.push(`start:${id}`);
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeCount -= 1;
      events.push(`end:${id}`);
      return id;
    };

    const first = __autoReflectionTestUtils.enqueueReflectionForAgent(
      "agent-same",
      makeLaunch("first"),
    );
    const second = __autoReflectionTestUtils.enqueueReflectionForAgent(
      "agent-same",
      makeLaunch("second"),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(maxActiveCount).toBe(1);
    expect(events).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
  });

  test("does not serialize reflection work across different agents", async () => {
    let releaseFirst = () => {};
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = () => {};
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let firstAgentActive = false;
    let overlapped = false;

    const first = __autoReflectionTestUtils.enqueueReflectionForAgent(
      "agent-one",
      async () => {
        firstAgentActive = true;
        firstStarted();
        await firstCanFinish;
        firstAgentActive = false;
        return "first";
      },
    );
    await firstDidStart;

    const second = __autoReflectionTestUtils.enqueueReflectionForAgent(
      "agent-two",
      async () => {
        overlapped = firstAgentActive;
        return "second";
      },
    );

    await expect(second).resolves.toBe("second");
    releaseFirst();
    await expect(first).resolves.toBe("first");
    expect(overlapped).toBe(true);
  });
});
