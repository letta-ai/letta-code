import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { type LocalModSource, resolveLocalModSources } from "@/mods/mod-engine";
import {
  parseGitManagedModPackageInstallSpecifier,
  updateGitManagedModPackage,
  updateNpmManagedModPackage,
} from "@/mods/package-installer";
import {
  listManagedModPackages,
  type ManagedModPackageDiagnostic,
  type ManagedModPackageListItem,
  removeManagedModPackage,
  setManagedModPackageEnabled,
} from "@/mods/package-registry";
import { scaffoldLocalModPackage } from "@/mods/package-scaffolder";
import {
  getGlobalModsDirectory,
  getLegacyGlobalExtensionsDirectory,
  resolveDefaultGlobalModsDirectory,
} from "@/mods/paths";

interface ModFileSection {
  files: string[];
  root: string;
}

export interface ModsList {
  agent?: ModFileSection;
  harness: ModFileSection;
  legacyHarness?: ModFileSection;
  packageDiagnostics: ManagedModPackageDiagnostic[];
  packages: ManagedModPackageListItem[];
}

export interface ListModsOptions {
  agentId?: string | null;
  agentModsDirectory?: string | null;
  globalModsDirectory?: string;
  legacyGlobalExtensionsDirectory?: string | null;
}

interface RunModsOptions {
  globalModsDirectory?: string;
}

const MODS_OPTIONS = {
  help: { type: "boolean", short: "h" },
  agent: { type: "string" },
  "agent-id": { type: "string" },
} as const;

const MODS_PACKAGE_OPTIONS = {
  ...MODS_OPTIONS,
  name: { type: "string" },
  out: { type: "string" },
} as const;

const RELOAD_HINT =
  "Run /reload in active sessions for changes to take effect.";

function printUsage(): void {
  console.log(
    `
Usage:
  letta mods list [--agent <id>]
  letta mods package <mod-file> --name <package-name> [--out <dir>]
  letta mods update <npm-package-spec | git-package-spec>
  letta mods enable <package-spec>
  letta mods disable <package-spec>
  letta mods remove <package-spec>

Options:
  --agent <id>       Include agent mods from this agent's MemFS directory
  --agent-id <id>    Alias for --agent
  -h, --help         Show this help
`.trim(),
  );
}

function parseModsArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: MODS_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function parseModsPackageArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: MODS_PACKAGE_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function getExplicitAgentId(
  values: ReturnType<typeof parseModsArgs>["values"],
): string | null {
  const explicitAgent = values.agent || values["agent-id"];
  return typeof explicitAgent === "string" && explicitAgent.trim()
    ? explicitAgent.trim()
    : null;
}

export function getAgentModsDirectory(agentId: string): string {
  return join(getScopedMemoryFilesystemRoot(agentId), "mods");
}

function directFilesForSource(source: LocalModSource): string[] {
  return source.files.filter((file) => dirname(file) === source.root);
}

function toSection(source: LocalModSource): ModFileSection {
  return {
    files: directFilesForSource(source),
    root: source.root,
  };
}

export function listMods(options: ListModsOptions = {}): ModsList {
  const agentModsDirectory =
    options.agentModsDirectory ??
    (options.agentId ? getAgentModsDirectory(options.agentId) : null);
  const globalModsDirectory =
    options.globalModsDirectory ?? getGlobalModsDirectory();
  const legacyGlobalExtensionsDirectory =
    options.legacyGlobalExtensionsDirectory ??
    (options.globalModsDirectory ? null : getLegacyGlobalExtensionsDirectory());
  const sources = resolveLocalModSources({
    ...(agentModsDirectory ? { agentModsDirectory } : {}),
    globalModsDirectory,
    ...(legacyGlobalExtensionsDirectory
      ? { legacyGlobalExtensionsDirectory }
      : {}),
  });
  const legacyHarness = sources.find(
    (source) => source.scope === "legacy_global",
  );
  const harness = sources.find((source) => source.scope === "global");
  const agent = sources.find((source) => source.scope === "agent");
  const managedPackages = listManagedModPackages(globalModsDirectory);
  const legacyManagedPackages = legacyGlobalExtensionsDirectory
    ? listManagedModPackages(legacyGlobalExtensionsDirectory)
    : { packages: [], diagnostics: [] };

  return {
    ...(agent ? { agent: toSection(agent) } : {}),
    harness: harness ? toSection(harness) : { files: [], root: "" },
    ...(legacyHarness ? { legacyHarness: toSection(legacyHarness) } : {}),
    packageDiagnostics: [
      ...managedPackages.diagnostics,
      ...legacyManagedPackages.diagnostics,
    ],
    packages: [...managedPackages.packages, ...legacyManagedPackages.packages],
  };
}

function formatModFileSection(title: string, section: ModFileSection): string {
  const lines = [title];
  if (section.files.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }

  for (const file of section.files) {
    lines.push(`  enabled  ${file}`);
  }
  return lines.join("\n");
}

function formatPackageSpecifier(pkg: ManagedModPackageListItem): string {
  return `${pkg.source}@${pkg.version}`;
}

function formatInstalledPackagesSection(
  mods: Pick<ModsList, "packageDiagnostics" | "packages">,
): string {
  const lines = ["Installed packages"];
  if (mods.packages.length === 0 && mods.packageDiagnostics.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }

  for (const pkg of mods.packages) {
    const status = pkg.enabled ? "enabled" : "disabled";
    const capabilities = pkg.capabilities.join(", ");
    lines.push(
      capabilities
        ? `  ${status}  ${formatPackageSpecifier(pkg)}    ${capabilities}`
        : `  ${status}  ${formatPackageSpecifier(pkg)}`,
    );
  }
  for (const diagnostic of mods.packageDiagnostics) {
    lines.push(`  error    ${diagnostic.path}    ${diagnostic.error.message}`);
  }
  return lines.join("\n");
}

export function formatModsList(mods: ModsList): string {
  const sections: string[] = [];
  if (mods.agent) {
    sections.push(formatModFileSection("Agent mods", mods.agent));
  }
  if (mods.legacyHarness) {
    sections.push(
      formatModFileSection("Legacy extensions", mods.legacyHarness),
    );
  }
  sections.push(formatModFileSection("Harness mods", mods.harness));
  sections.push(formatInstalledPackagesSection(mods));
  return sections.join("\n\n");
}

async function runList(
  argv: string[],
  options: RunModsOptions = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseModsArgs>;
  try {
    parsed = parseModsArgs(argv);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    return 1;
  }

  if (parsed.values.help) {
    printUsage();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    console.error(`Unexpected argument: ${parsed.positionals[0]}`);
    printUsage();
    return 1;
  }

  const agentId = getExplicitAgentId(parsed.values);
  const mods = listMods({
    agentId,
    ...(options.globalModsDirectory
      ? { globalModsDirectory: options.globalModsDirectory }
      : {}),
  });
  console.log(formatModsList(mods));
  return 0;
}

async function runPackageMutation(
  action: "disable" | "enable" | "remove",
  argv: string[],
  options: RunModsOptions = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseModsArgs>;
  try {
    parsed = parseModsArgs(argv);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    return 1;
  }

  if (parsed.values.help) {
    printUsage();
    return 0;
  }
  if (getExplicitAgentId(parsed.values)) {
    console.error(`--agent is only supported for 'letta mods list'.`);
    printUsage();
    return 1;
  }

  const [specifier, extra] = parsed.positionals;
  if (!specifier) {
    console.error(`Missing package specifier.`);
    printUsage();
    return 1;
  }
  if (extra) {
    console.error(`Unexpected argument: ${extra}`);
    printUsage();
    return 1;
  }

  try {
    const modsRoot =
      options.globalModsDirectory ?? resolveDefaultGlobalModsDirectory();
    const result =
      action === "remove"
        ? removeManagedModPackage({ modsRoot, specifier })
        : setManagedModPackageEnabled({
            enabled: action === "enable",
            modsRoot,
            specifier,
          });
    const packageSpec = formatPackageSpecifier(result.package);
    const status =
      action === "remove"
        ? "removed"
        : action === "enable"
          ? "enabled"
          : "disabled";
    console.log(`${status} ${packageSpec}`);
    console.log(RELOAD_HINT);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runPackageUpdate(
  argv: string[],
  options: RunModsOptions = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseModsArgs>;
  try {
    parsed = parseModsArgs(argv);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    return 1;
  }

  if (parsed.values.help) {
    printUsage();
    return 0;
  }
  if (getExplicitAgentId(parsed.values)) {
    console.error(`--agent is not supported for 'letta mods update'.`);
    printUsage();
    return 1;
  }

  const [specifier, extra] = parsed.positionals;
  if (!specifier) {
    console.error(`Missing package specifier.`);
    printUsage();
    return 1;
  }
  if (extra) {
    console.error(`Unexpected argument: ${extra}`);
    printUsage();
    return 1;
  }

  try {
    const modsRoot =
      options.globalModsDirectory ?? resolveDefaultGlobalModsDirectory();
    const gitParsed = parseGitManagedModPackageInstallSpecifier(specifier);
    const result = gitParsed
      ? await updateGitManagedModPackage({ modsRoot, specifier })
      : await updateNpmManagedModPackage({ modsRoot, specifier });
    const disabledSuffix = result.enabled ? "" : " (disabled)";
    console.log(
      `Updated ${result.source} ${result.previousVersion} -> ${result.version}${disabledSuffix}`,
    );
    console.log(RELOAD_HINT);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runPackageScaffold(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseModsPackageArgs>;
  try {
    parsed = parseModsPackageArgs(argv);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    return 1;
  }

  if (parsed.values.help) {
    printUsage();
    return 0;
  }
  if (getExplicitAgentId(parsed.values)) {
    console.error(`--agent is not supported for 'letta mods package'.`);
    printUsage();
    return 1;
  }

  const [sourceFile, extra] = parsed.positionals;
  if (!sourceFile) {
    console.error(`Missing mod file.`);
    printUsage();
    return 1;
  }
  if (extra) {
    console.error(`Unexpected argument: ${extra}`);
    printUsage();
    return 1;
  }
  const packageName = parsed.values.name;
  if (typeof packageName !== "string" || !packageName.trim()) {
    console.error(`Missing required --name <package-name>.`);
    printUsage();
    return 1;
  }

  try {
    const result = scaffoldLocalModPackage({
      ...(typeof parsed.values.out === "string" && parsed.values.out.trim()
        ? { outputDirectory: parsed.values.out }
        : {}),
      packageName,
      sourceFile,
    });
    console.log(`Created mod package ${result.outputDirectory}`);
    console.log(`Copied ${result.sourceFile} -> ${result.targetModPath}`);
    console.log(
      "The original mod file is still present and may still load until you remove it.",
    );
    console.log(`Install with: ${result.installCommand}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runModsSubcommand(
  argv: string[],
  options: RunModsOptions = {},
): Promise<number> {
  const [action, ...rest] = argv;

  if (!action || action === "help" || action === "--help" || action === "-h") {
    printUsage();
    return 0;
  }

  switch (action) {
    case "list":
      return runList(rest, options);
    case "package":
      return runPackageScaffold(rest);
    case "update":
      return runPackageUpdate(rest, options);
    case "enable":
    case "disable":
    case "remove":
      return runPackageMutation(action, rest, options);
    default:
      console.error(`Unknown mods action: ${action}`);
      printUsage();
      return 1;
  }
}
