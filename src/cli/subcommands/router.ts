import { runMemfsSubcommand } from "./memfs";

export async function runSubcommand(argv: string[]): Promise<number | null> {
  const [command, ...rest] = argv;

  if (!command) {
    return null;
  }

  switch (command) {
    case "memfs":
      return runMemfsSubcommand(rest);
    default:
      return null;
  }
}
