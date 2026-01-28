import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  calculateLuminance,
  detectTerminalThemeSync,
  parseHexComponent,
} from "../../cli/helpers/terminalTheme";

describe("parseHexComponent", () => {
  test("parses 2-digit hex (standard 8-bit)", () => {
    expect(parseHexComponent("00")).toBe(0);
    expect(parseHexComponent("ff")).toBe(255);
    expect(parseHexComponent("80")).toBe(128);
    expect(parseHexComponent("7f")).toBe(127);
  });

  test("parses 4-digit hex (16-bit) and normalizes to 8-bit", () => {
    expect(parseHexComponent("0000")).toBe(0);
    expect(parseHexComponent("ffff")).toBe(255);
    // 8000/ffff * 255 ≈ 128
    expect(parseHexComponent("8000")).toBe(128);
  });

  test("parses 1-digit hex and normalizes to 8-bit", () => {
    expect(parseHexComponent("0")).toBe(0);
    expect(parseHexComponent("f")).toBe(255);
    // 8/15 * 255 = 136
    expect(parseHexComponent("8")).toBe(136);
  });

  test("parses 3-digit hex and normalizes to 8-bit", () => {
    expect(parseHexComponent("000")).toBe(0);
    expect(parseHexComponent("fff")).toBe(255);
  });
});

describe("calculateLuminance", () => {
  test("returns 0 for pure black", () => {
    expect(calculateLuminance(0, 0, 0)).toBe(0);
  });

  test("returns ~1 for pure white", () => {
    expect(calculateLuminance(255, 255, 255)).toBeCloseTo(1, 2);
  });

  test("red has higher luminance than blue", () => {
    const redLum = calculateLuminance(255, 0, 0);
    const blueLum = calculateLuminance(0, 0, 255);
    expect(redLum).toBeGreaterThan(blueLum);
  });

  test("green contributes most to luminance (BT.709)", () => {
    const redLum = calculateLuminance(255, 0, 0);
    const greenLum = calculateLuminance(0, 255, 0);
    const blueLum = calculateLuminance(0, 0, 255);
    expect(greenLum).toBeGreaterThan(redLum);
    expect(greenLum).toBeGreaterThan(blueLum);
  });

  test("mid-gray has luminance around 0.2", () => {
    // sRGB mid-gray (128, 128, 128) has relative luminance ~0.216
    const lum = calculateLuminance(128, 128, 128);
    expect(lum).toBeGreaterThan(0.19);
    expect(lum).toBeLessThan(0.23);
  });
});

describe("detectTerminalThemeSync", () => {
  let originalEnv: string | undefined;

  beforeAll(() => {
    originalEnv = process.env.COLORFGBG;
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.COLORFGBG = originalEnv;
    } else {
      delete process.env.COLORFGBG;
    }
  });

  test("returns 'dark' when COLORFGBG is not set", () => {
    delete process.env.COLORFGBG;
    expect(detectTerminalThemeSync()).toBe("dark");
  });

  test("returns 'light' when COLORFGBG background is 7", () => {
    process.env.COLORFGBG = "0;7";
    expect(detectTerminalThemeSync()).toBe("light");
  });

  test("returns 'light' when COLORFGBG background is 15", () => {
    process.env.COLORFGBG = "0;15";
    expect(detectTerminalThemeSync()).toBe("light");
  });

  test("returns 'dark' when COLORFGBG background is 0", () => {
    process.env.COLORFGBG = "15;0";
    expect(detectTerminalThemeSync()).toBe("dark");
  });
});
