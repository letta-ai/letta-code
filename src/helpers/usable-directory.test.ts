import { describe, expect, test } from "bun:test";
import {
  getDirectoryUsability,
  isConfirmedUnusableDirectory,
} from "./usable-directory";

describe("directory usability", () => {
  test("classifies missing paths and regular files as confirmed unusable", () => {
    expect(getDirectoryUsability("/missing", () => undefined)).toBe("missing");
    expect(
      getDirectoryUsability("/file", () => ({ isDirectory: () => false })),
    ).toBe("not-directory");
  });

  test("preserves paths when stat fails unexpectedly", () => {
    const statDirectory = () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    };

    expect(getDirectoryUsability("/restricted", statDirectory)).toBe("unknown");
    expect(isConfirmedUnusableDirectory("/restricted", statDirectory)).toBe(
      false,
    );
  });
});
