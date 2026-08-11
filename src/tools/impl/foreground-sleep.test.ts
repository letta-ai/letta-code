import { describe, expect, test } from "bun:test";
import { commandRunsForegroundSleep } from "./foreground-sleep";

describe("commandRunsForegroundSleep", () => {
  test("blocks a bare sleep", () => {
    expect(commandRunsForegroundSleep("sleep 5")).toBe(true);
  });

  test("blocks sleep chained with other commands", () => {
    expect(commandRunsForegroundSleep("sleep 5 && npm test")).toBe(true);
    expect(commandRunsForegroundSleep("npm run build; sleep 2; ls")).toBe(true);
  });

  test("blocks sleep inside a foreground poll loop", () => {
    expect(commandRunsForegroundSleep("while true; do sleep 1; done")).toBe(
      true,
    );
    expect(
      commandRunsForegroundSleep(
        'until grep -q "Ready in" dev.log; do sleep 0.5; done',
      ),
    ).toBe(true);
  });

  test("blocks sleep invoked by path or with an env assignment prefix", () => {
    expect(commandRunsForegroundSleep("/bin/sleep 5")).toBe(true);
    expect(commandRunsForegroundSleep("FOO=bar sleep 5")).toBe(true);
  });

  test("allows sleep in argument position", () => {
    expect(commandRunsForegroundSleep("grep sleep file.txt")).toBe(false);
    expect(commandRunsForegroundSleep("echo sleep 5")).toBe(false);
  });

  test("allows sleep inside quoted strings", () => {
    expect(commandRunsForegroundSleep("git commit -m 'fix; sleep well'")).toBe(
      false,
    );
  });

  test("allows commands without sleep", () => {
    expect(commandRunsForegroundSleep("npm test")).toBe(false);
    expect(commandRunsForegroundSleep("tail -f app.log | grep ERROR")).toBe(
      false,
    );
  });

  test("lets unanalyzable commands through (nudge, not security boundary)", () => {
    expect(commandRunsForegroundSleep("sleep 5 > out.txt")).toBe(false);
  });
});
