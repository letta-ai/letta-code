import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canonicalRuntimeGraph,
  runtimeGraphDigest,
  verifyRuntimeGraph,
} from "./runtime-graph";

const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

function dependencyLock() {
  return {
    name: "@letta-ai/letta-code",
    version: "1.2.3",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "@letta-ai/letta-code",
        version: "1.2.3",
        dependencies: { dependency: "^4.0.0" },
        optionalDependencies: {},
      },
      "node_modules/dependency": {
        version: "4.5.6",
        resolved:
          "https://registry.npmjs.org/dependency/-/dependency-4.5.6.tgz",
        integrity,
        libc: ["musl", "glibc"],
      },
    },
  };
}

describe("runtime dependency graph protocol", () => {
  test("matches the daemon's canonical graph digest", () => {
    const lock = dependencyLock();
    const canonical = [
      {
        location: "node_modules/dependency",
        version: "4.5.6",
        resolved:
          "https://registry.npmjs.org/dependency/-/dependency-4.5.6.tgz",
        integrity,
        optional: false,
        os: [],
        cpu: [],
        libc: ["glibc", "musl"],
      },
    ];
    const expected = `sha512-${createHash("sha512")
      .update(JSON.stringify(canonical))
      .digest("base64")}`;

    expect(canonicalRuntimeGraph(lock)).toEqual(canonical);
    expect(runtimeGraphDigest(lock)).toBe(expected);
  });

  test("includes libc compatibility in the canonical digest", () => {
    const multiLibcLock = dependencyLock();
    const muslOnlyLock = dependencyLock();
    muslOnlyLock.packages["node_modules/dependency"].libc = ["musl"];

    expect(runtimeGraphDigest(multiLibcLock)).not.toBe(
      runtimeGraphDigest(muslOnlyLock),
    );
  });

  test("verifies the release manifest declaration and shrinkwrap root", () => {
    const lock = dependencyLock();
    const digest = runtimeGraphDigest(lock);

    expect(
      verifyRuntimeGraph(
        {
          name: "@letta-ai/letta-code",
          version: "1.2.3",
          dependencies: { dependency: "^4.0.0" },
          optionalDependencies: {},
          lettaRuntimeGraphProtocol: 1,
          lettaRuntimeGraphSha512: digest,
        },
        lock,
      ),
    ).toBe(digest);
  });

  test("rejects mutable or non-canonical dependency artifacts", () => {
    const lock = dependencyLock();
    lock.packages["node_modules/dependency"].resolved =
      "https://registry.example.test/dependency.tgz";

    expect(() => runtimeGraphDigest(lock)).toThrow(/not canonical/);
  });

  test("rejects a stale release declaration", () => {
    const lock = dependencyLock();

    expect(() =>
      verifyRuntimeGraph(
        {
          name: "@letta-ai/letta-code",
          version: "1.2.3",
          dependencies: { dependency: "^4.0.0" },
          optionalDependencies: {},
          lettaRuntimeGraphProtocol: 1,
          lettaRuntimeGraphSha512: `sha512-${Buffer.alloc(64).toString("base64")}`,
        },
        lock,
      ),
    ).toThrow(/declaration is stale/);
  });
});
