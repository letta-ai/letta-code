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
    for (const code of ["EACCES", "EIO", "EMFILE"]) {
      const statDirectory = () => {
        throw Object.assign(new Error("unexpected stat failure"), { code });
      };

      expect(getDirectoryUsability("/restricted", statDirectory)).toBe(
        "unknown",
      );
      expect(isConfirmedUnusableDirectory("/restricted", statDirectory)).toBe(
        false,
      );
    }
  });

  test("treats thrown missing-path errors as confirmed unusable", () => {
    for (const code of ["ENOENT", "ENOTDIR"]) {
      const statDirectory = () => {
        throw Object.assign(new Error("missing path"), { code });
      };

      expect(getDirectoryUsability("/missing", statDirectory)).toBe("missing");
      expect(isConfirmedUnusableDirectory("/missing", statDirectory)).toBe(
        true,
      );
    }
  });
});
