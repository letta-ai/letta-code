import { expect, test } from "bun:test";
import { renderLinuxAutostart } from "./linux-autostart";

test("renders a quoted Linux autostart entry", () => {
  expect(renderLinuxAutostart('/home/user/Letta $Build/daemon"test')).toContain(
    'Exec="/home/user/Letta \\$Build/daemon\\"test"',
  );
});
