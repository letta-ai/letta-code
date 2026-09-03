import { afterEach, describe, expect, test } from "bun:test";
import { getClientDefaultHeaders } from "@/backend/api/client";

const originalMemfsBackend = process.env.LETTA_MEMFS_BACKEND;

afterEach(() => {
  if (originalMemfsBackend === undefined) {
    delete process.env.LETTA_MEMFS_BACKEND;
  } else {
    process.env.LETTA_MEMFS_BACKEND = originalMemfsBackend;
  }
});

describe("getClient experiment headers", () => {
  test("sends hosted backend header when requested", () => {
    process.env.LETTA_MEMFS_BACKEND = "hosted";

    expect(getClientDefaultHeaders()["x-letta-memfs-backend"]).toBe("hosted");
  });
});
