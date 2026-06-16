import { describe, expect, test } from "bun:test";
import {
  normalizeSignalBaseUrl,
  normalizeSignalPhoneInput,
  parseSignalCsv,
} from "./setup";

describe("Signal setup helpers", () => {
  test("normalizes base URLs for signal-cli-rest-api", () => {
    expect(normalizeSignalBaseUrl("")).toBe("http://127.0.0.1:8080");
    expect(normalizeSignalBaseUrl("http://127.0.0.1:8080/")).toBe(
      "http://127.0.0.1:8080",
    );
    expect(normalizeSignalBaseUrl("https://signal.example.test/events")).toBe(
      "https://signal.example.test/events",
    );
    expect(normalizeSignalBaseUrl("file:///tmp/signal")).toBeUndefined();
    expect(normalizeSignalBaseUrl("not a url")).toBeUndefined();
  });

  test("normalizes Signal E.164 phone input", () => {
    expect(normalizeSignalPhoneInput("+1 (555) 555-0100")).toBe("+15555550100");
    expect(normalizeSignalPhoneInput("15555550100")).toBe("+15555550100");
    expect(normalizeSignalPhoneInput("abc")).toBeUndefined();
    expect(normalizeSignalPhoneInput("+12")).toBeUndefined();
  });

  test("parses comma-separated setup entries", () => {
    expect(parseSignalCsv("+1555, uuid:abc, , group-1")).toEqual([
      "+1555",
      "uuid:abc",
      "group-1",
    ]);
  });
});
