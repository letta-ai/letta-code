import { describe, expect, test } from "bun:test";

const useInputModuleUrl = new URL(
  "../../node_modules/ink/build/hooks/use-input.js",
  import.meta.url,
).href;

async function loadTestUtils() {
  const mod = await import(useInputModuleUrl);
  return mod.__lettaUseInputTestUtils as {
    isProtocolReportSequence: (data: unknown) => boolean;
    stripTrailingNewlineFromCsiU: (data: unknown) => unknown;
    shouldSuppressBareEnterAfterModifiedEnter: (
      data: unknown,
      suppressBareEnter: boolean,
      platform?: string,
    ) => boolean;
    shouldStartModifiedEnterSuppression: (
      keypress: {
        name?: string;
        shift?: boolean;
        ctrl?: boolean;
        meta?: boolean;
        option?: boolean;
      },
      platform?: string,
    ) => boolean;
    shouldTreatAsReturn: (keypressName: string, platform?: string) => boolean;
  };
}

describe("use-input key sequence handling", () => {
  test("filters protocol report spam sequences", async () => {
    const t = await loadTestUtils();

    expect(t.isProtocolReportSequence("\x1b[?1u")).toBe(true);
    expect(
      t.isProtocolReportSequence("\x1b[?0u\x1b[?64;1;2;4;6;17;18;21;22;52c"),
    ).toBe(true);
    expect(t.isProtocolReportSequence("\x1b[13;2u")).toBe(false);
    expect(t.isProtocolReportSequence("a")).toBe(false);
  });

  test("strips only trailing newline from CSI-u Enter payload", async () => {
    const t = await loadTestUtils();

    expect(t.stripTrailingNewlineFromCsiU("\x1b[13;2u\n")).toBe("\x1b[13;2u");
    expect(t.stripTrailingNewlineFromCsiU("\x1b[13;2:1u\r\n")).toBe(
      "\x1b[13;2:1u",
    );
    expect(t.stripTrailingNewlineFromCsiU("\x1b[13;2u")).toBe("\x1b[13;2u");
  });

  test("maps Enter-as-submit by platform correctly", async () => {
    const t = await loadTestUtils();

    expect(t.shouldTreatAsReturn("return", "linux")).toBe(true);
    expect(t.shouldTreatAsReturn("enter", "linux")).toBe(true);
    expect(t.shouldTreatAsReturn("return", "darwin")).toBe(true);
    expect(t.shouldTreatAsReturn("enter", "darwin")).toBe(false);
  });

  test("suppresses only immediate bare enter after modified enter on linux", async () => {
    const t = await loadTestUtils();

    expect(
      t.shouldStartModifiedEnterSuppression(
        { name: "return", shift: true },
        "linux",
      ),
    ).toBe(true);
    expect(
      t.shouldSuppressBareEnterAfterModifiedEnter("\n", true, "linux"),
    ).toBe(true);

    expect(
      t.shouldStartModifiedEnterSuppression(
        { name: "return", shift: true },
        "darwin",
      ),
    ).toBe(false);
    expect(
      t.shouldSuppressBareEnterAfterModifiedEnter("\n", true, "darwin"),
    ).toBe(false);
  });
});
