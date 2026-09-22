import chalk, { Chalk, type ChalkInstance } from "chalk";
import { staticLogoLines } from "@/cli/components/AnimatedLogo";

/**
 * One-shot banner for a computer's first registration (typically pasted from
 * onboarding). Printed once with console.log and left in the scrollback.
 *
 * Written directly rather than through Ink: Ink emits cursor/erase control
 * bytes even when stdout is redirected, which would corrupt the plain-text
 * `letta server --debug > file` path. Colors go through chalk so the banner
 * follows the CLI's color-level detection (24-bit, 256-color on Terminal.app,
 * none at level 0). The logo only exists as background-color cells, so it is
 * dropped when chalk reports no color support.
 */
export function formatFirstRunWelcome(
  computerName: string,
  paint: ChalkInstance,
): string[] {
  const logo = paint.level > 0 ? [...staticLogoLines(paint), ""] : [];
  return [
    "",
    ...logo,
    paint.bold("Welcome to Letta"),
    paint.dim(
      `Registering this computer as "${computerName}" so your agent can work here. Use --computer-name to change it.`,
    ),
    "",
  ];
}

/**
 * Chalk's own detection ignores NO_COLOR (it only reads the TTY, FORCE_COLOR,
 * and CLI flags), so honor the convention explicitly before painting.
 */
export function firstRunWelcomeChalk(
  env: NodeJS.ProcessEnv = process.env,
): ChalkInstance {
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  return new Chalk({ level: noColor ? 0 : chalk.level });
}

export function printFirstRunWelcome(computerName: string): void {
  for (const line of formatFirstRunWelcome(
    computerName,
    firstRunWelcomeChalk(),
  )) {
    console.log(line);
  }
}
