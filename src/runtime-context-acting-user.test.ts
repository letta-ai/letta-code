import { expect, test } from "bun:test";
import { ACTING_USER_ID_ENV } from "@/agent/acting-user";
import {
  getRuntimeActingUserId,
  runWithRuntimeContext,
} from "./runtime-context";

test("runtime actor suppression blocks ambient process attribution", () => {
  const previous = process.env[ACTING_USER_ID_ENV];
  process.env[ACTING_USER_ID_ENV] = "ambient-user";
  try {
    expect(getRuntimeActingUserId()).toBe("ambient-user");
    runWithRuntimeContext({ suppressActingUserFallback: true }, () =>
      expect(getRuntimeActingUserId()).toBeUndefined(),
    );
    runWithRuntimeContext({ actingUserId: "explicit-user" }, () =>
      expect(getRuntimeActingUserId()).toBe("explicit-user"),
    );
  } finally {
    if (previous === undefined) delete process.env[ACTING_USER_ID_ENV];
    else process.env[ACTING_USER_ID_ENV] = previous;
  }
});
