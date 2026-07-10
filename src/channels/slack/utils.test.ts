import { expect, test } from "bun:test";
import { resolveSlackAppConstructor } from "./utils";

class FakeSlackApp {}

test("resolveSlackAppConstructor supports nested default Slack Bolt exports", () => {
  const nestedModule = {
    default: {
      default: {
        App: FakeSlackApp,
      },
    },
  } as unknown as Parameters<typeof resolveSlackAppConstructor>[0];

  expect(resolveSlackAppConstructor(nestedModule) as unknown).toBe(
    FakeSlackApp,
  );
});
