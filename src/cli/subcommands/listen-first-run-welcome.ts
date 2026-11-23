import chalk, { Chalk, type ChalkInstance } from "chalk";
import { staticLogoLines } from "@/cli/components/AnimatedLogo";

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
