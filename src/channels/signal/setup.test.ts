import { describe, expect, test } from "bun:test";
import {
  extractSignalAccountsFromResponse,
  getSignalDockerRunCommand,
  getSignalQrLinkUrl,
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

  test("documents the Docker daemon command used by interactive setup", () => {
    const command = getSignalDockerRunCommand();
    expect(command).toContain("bbernhard/signal-cli-rest-api:latest");
    expect(command).toContain("MODE=json-rpc");
    expect(command).toContain("8080:8080");
    expect(command).toContain("letta-signal-cli-data");
  });

  test("extracts account numbers from daemon account responses", () => {
    expect(extractSignalAccountsFromResponse(["+15550000001"])).toEqual([
      "+15550000001",
    ]);
    expect(
      extractSignalAccountsFromResponse({
        accounts: [{ number: "+15550000002" }, { account: "+15550000003" }],
      }),
    ).toEqual(["+15550000002", "+15550000003"]);
    expect(extractSignalAccountsFromResponse({})).toEqual([]);
  });

  test("builds QR link URL for device linking", () => {
    expect(getSignalQrLinkUrl("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080/v1/qrcodelink?device_name=Letta+Code",
    );
  });
});
