import { describe, expect, test } from "bun:test";
import { renderSignalQrTerminal } from "./runtime";
import {
  extractSignalAccountsFromResponse,
  getSignalDockerRunCommand,
  getSignalQrLinkUrl,
  hasSignalSetupRestEndpoints,
  normalizeSignalBaseUrl,
  normalizeSignalPhoneInput,
  parseNativeSignalCliDaemonConfigDir,
  parseSignalCliDeletePath,
  parseSignalCsv,
  parseSignalLinkAssociatedAccount,
  parseSignalLinkExistingAccount,
  parseSignalLinkUri,
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

  test("detects whether setup REST endpoints are available", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response("{}", { status: 200 })) as unknown as typeof fetch;
      expect(await hasSignalSetupRestEndpoints("http://signal.test")).toBe(
        true,
      );
      globalThis.fetch = (async () =>
        new Response("not found", { status: 404 })) as unknown as typeof fetch;
      expect(await hasSignalSetupRestEndpoints("http://signal.test")).toBe(
        false,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("parses native signal-cli daemon config directory from process text", () => {
    expect(
      parseNativeSignalCliDaemonConfigDir(
        "signal-cli -c /tmp/signal-data daemon --http 127.0.0.1:8080",
      ),
    ).toBe("/tmp/signal-data");
    expect(
      parseNativeSignalCliDaemonConfigDir(
        "signal-cli --config /tmp/signal-data daemon",
      ),
    ).toBe("/tmp/signal-data");
    expect(
      parseNativeSignalCliDaemonConfigDir(
        'signal-cli -c "/tmp/signal data" daemon',
      ),
    ).toBe("/tmp/signal data");
    expect(
      parseNativeSignalCliDaemonConfigDir(
        "signal-cli --data-dir '/tmp/signal data' daemon",
      ),
    ).toBe("/tmp/signal data");
    expect(parseNativeSignalCliDaemonConfigDir("signal-cli daemon")).toBeNull();
  });

  test("parses linked Signal account from native link output", () => {
    expect(
      parseSignalLinkAssociatedAccount(
        "INFO something\nAssociated with: +15036195666\n",
      ),
    ).toBe("+15036195666");
    expect(parseSignalLinkAssociatedAccount("no phone here")).toBeNull();
  });

  test("parses already-linked Signal account from native link errors", () => {
    expect(
      parseSignalLinkExistingAccount(
        'The user +15036195666 already exists\nDelete "/tmp/data/747879" before trying again.',
      ),
    ).toBe("+15036195666");
    expect(parseSignalLinkExistingAccount("different failure")).toBeNull();
  });

  test("parses existing-account native link failure", () => {
    const output =
      'The user +15036195666 already exists\nDelete "/tmp/signal/data/747879" before trying again.';
    expect(parseSignalLinkExistingAccount(output)).toBe("+15036195666");
    expect(parseSignalCliDeletePath(output)).toBe("/tmp/signal/data/747879");
    expect(parseSignalLinkExistingAccount("no account")).toBeNull();
    expect(parseSignalCliDeletePath("no path")).toBeNull();
  });

  test("parses native link URI for QR rendering", () => {
    expect(
      parseSignalLinkUri(
        "sgnl://linkdevice?uuid=abc&pub_key=def\nAssociated with: +15036195666",
      ),
    ).toBe("sgnl://linkdevice?uuid=abc&pub_key=def");
    expect(parseSignalLinkUri("no link here")).toBeNull();
  });

  test("renders qrcode-terminal output for native link URI", () => {
    const qrMod = {
      generate(input: string, options: unknown, cb?: (output: string) => void) {
        cb?.(`${input}:${JSON.stringify(options)}`);
      },
    };
    expect(renderSignalQrTerminal(qrMod, "sgnl://linkdevice?x=1")).toBe(
      'sgnl://linkdevice?x=1:{"small":true}',
    );
  });
});
