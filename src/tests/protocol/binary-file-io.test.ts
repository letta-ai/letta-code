import { describe, expect, test } from "bun:test";
import {
  isReadFileCommand,
  isWriteFileCommand,
} from "../../websocket/listener/protocol-inbound";

/**
 * Validators for the optional `encoding` field on read_file / write_file
 * commands. Omitted is valid (defaults to 'utf8'); explicit must be exactly
 * 'utf8' or 'base64'.
 */
describe("isReadFileCommand encoding validation", () => {
  const baseValid = {
    type: "read_file",
    path: "/tmp/foo.txt",
    request_id: "req-1",
  };

  test("accepts omitted encoding", () => {
    expect(isReadFileCommand(baseValid)).toBe(true);
  });

  test("accepts encoding: 'utf8'", () => {
    expect(isReadFileCommand({ ...baseValid, encoding: "utf8" })).toBe(true);
  });

  test("accepts encoding: 'base64'", () => {
    expect(isReadFileCommand({ ...baseValid, encoding: "base64" })).toBe(true);
  });

  test("rejects unknown encoding string", () => {
    expect(isReadFileCommand({ ...baseValid, encoding: "hex" })).toBe(false);
  });

  test("rejects non-string encoding", () => {
    expect(isReadFileCommand({ ...baseValid, encoding: 0 })).toBe(false);
    expect(isReadFileCommand({ ...baseValid, encoding: null })).toBe(false);
    expect(isReadFileCommand({ ...baseValid, encoding: true })).toBe(false);
  });
});

describe("isWriteFileCommand encoding validation", () => {
  const baseValid = {
    type: "write_file",
    path: "/tmp/foo.txt",
    content: "hello",
    request_id: "req-1",
  };

  test("accepts omitted encoding", () => {
    expect(isWriteFileCommand(baseValid)).toBe(true);
  });

  test("accepts encoding: 'utf8'", () => {
    expect(isWriteFileCommand({ ...baseValid, encoding: "utf8" })).toBe(true);
  });

  test("accepts encoding: 'base64'", () => {
    expect(isWriteFileCommand({ ...baseValid, encoding: "base64" })).toBe(true);
  });

  test("rejects unknown encoding string", () => {
    expect(isWriteFileCommand({ ...baseValid, encoding: "binary" })).toBe(
      false,
    );
  });

  test("rejects non-string encoding", () => {
    expect(isWriteFileCommand({ ...baseValid, encoding: 0 })).toBe(false);
    expect(isWriteFileCommand({ ...baseValid, encoding: {} })).toBe(false);
  });
});

/**
 * Round-trip sanity: confirm Buffer.from(...).toString('base64') and the
 * inverse round-trip a small binary fixture byte-identically. This is the
 * exact transform the device handler performs; if Node's base64 ever
 * regressed this we'd want to know loudly.
 */
describe("base64 round-trip", () => {
  test("byte-identical round-trip for a small PNG header fixture", () => {
    // PNG magic bytes + first IHDR length, just enough to look real.
    const original = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const encoded = original.toString("base64");
    const decoded = Buffer.from(encoded, "base64");
    expect(decoded.equals(original)).toBe(true);
  });

  test("round-trips bytes that are invalid utf-8", () => {
    // 0xff, 0xfe is invalid as utf-8 — would be corrupted if we accidentally
    // routed binary through the utf-8 path.
    const original = Buffer.from([0xff, 0xfe, 0x00, 0xc0, 0x80]);
    const encoded = original.toString("base64");
    const decoded = Buffer.from(encoded, "base64");
    expect(decoded.equals(original)).toBe(true);
  });
});
