import { describe, expect, test } from "bun:test";

import {
  injectWezTermDeleteFix,
  wezTermDeleteFixExists,
} from "../../cli/utils/terminalKeybindingInstaller";

describe("injectWezTermDeleteFix", () => {
  test("injects before the real return config line, not a commented one", () => {
    const input = `---- Pull in the wezterm API
--local wezterm = require 'wezterm'
--
---- This will hold the configuration.
--local config = wezterm.config_builder()
--
--return config

local wezterm = require 'wezterm'
local config = wezterm.config_builder()

config.color_scheme = 'Tokyo Night'

return config
`;

    const output = injectWezTermDeleteFix(input);

    expect(output).toContain("--return config");
    expect(output).toContain("config.color_scheme = 'Tokyo Night'");
    expect(output).toContain("key = 'Delete'");

    const markerIdx = output.indexOf("-- Letta Code: Fix Delete key");
    const liveReturnIdx = output.lastIndexOf("return config");
    const colorIdx = output.indexOf("config.color_scheme = 'Tokyo Night'");

    expect(markerIdx).toBeGreaterThan(colorIdx);
    expect(markerIdx).toBeLessThan(liveReturnIdx);
    expect(output.match(/^\s*return config\s*$/gm)?.length).toBe(1);
  });

  test("emits a Lua escape sequence for ESC[3~ instead of a literal backslash", () => {
    const output = injectWezTermDeleteFix(
      "local config = {}\n\nreturn config\n",
    );

    expect(output).toContain("SendString '\\x1b[3~'");
    expect(output).not.toContain("SendString '\\\\x1b[3~'");
  });

  test("converts simple return-table configs to local config form", () => {
    const output = injectWezTermDeleteFix(
      "return {\n  color_scheme = 'Tokyo Night',\n}\n",
    );

    expect(output).toContain("local config = {");
    expect(output).toContain("color_scheme = 'Tokyo Night'");
    expect(output).toContain("key = 'Delete'");
    expect(output).toContain("return config");
  });
});

describe("wezTermDeleteFixExists", () => {
  test("recognizes the correct escaped Delete binding text", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wezterm-fix-"));
    const filePath = path.join(tempDir, "wezterm.lua");
    fs.writeFileSync(
      filePath,
      "local config = {}\nconfig.keys = {{ key = 'Delete', action = wezterm.action.SendString '\\x1b[3~' }}\nreturn config\n",
      "utf-8",
    );

    expect(wezTermDeleteFixExists(filePath)).toBe(true);
  });
});
