import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

function detectLinuxLibc(platform) {
  if (platform !== "linux") {
    return "";
  }

  try {
    return process.report?.getReport()?.header?.glibcVersionRuntime
      ? ""
      : "musl";
  } catch {
    return "";
  }
}

export function resolveSharpRuntimePlatform({
  platform = process.platform,
  arch = process.arch,
  libc,
} = {}) {
  const resolvedLibc = libc === undefined ? detectLinuxLibc(platform) : libc;
  return `${platform}${platform === "linux" ? resolvedLibc : ""}-${arch}`;
}

export function getSharpPlatformPackages(
  optionalDependencies,
  runtimePlatform,
) {
  const sharpPackage = `@img/sharp-${runtimePlatform}`;
  const libvipsPackage = `@img/sharp-libvips-${runtimePlatform}`;
  const packages = [
    { name: sharpPackage, version: optionalDependencies[sharpPackage] },
  ];

  if (optionalDependencies[sharpPackage] === undefined) {
    return [];
  }

  if (optionalDependencies[libvipsPackage] !== undefined) {
    packages.push({
      name: libvipsPackage,
      version: optionalDependencies[libvipsPackage],
    });
  }

  return packages;
}

function resolvePackageBinding(packageName, projectRoot) {
  const projectRequire = createRequire(join(projectRoot, "package.json"));
  try {
    return projectRequire.resolve(`${packageName}/sharp.node`);
  } catch {
    return null;
  }
}

function installSharpPlatformPackages(packages, projectRoot) {
  const installRoot = mkdtempSync(join(tmpdir(), "letta-sharp-repair-"));
  const bundledNpmCli = join(
    process.execPath,
    "..",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const npmCommand = existsSync(bundledNpmCli)
    ? { command: process.execPath, args: [bundledNpmCli] }
    : { command: "npm", args: [] };

  try {
    execFileSync(
      npmCommand.command,
      [
        ...npmCommand.args,
        "install",
        "--ignore-scripts",
        "--no-save",
        "--no-package-lock",
        "--prefix",
        installRoot,
        ...packages.map(({ name, version }) => `${name}@${version}`),
      ],
      { cwd: projectRoot, stdio: "inherit" },
    );

    for (const { name } of packages) {
      const source = join(installRoot, "node_modules", ...name.split("/"));
      const destination = join(projectRoot, "node_modules", ...name.split("/"));
      cpSync(source, destination, { recursive: true, force: true });
    }
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
}

export async function repairSharpNativeBinding({
  projectRoot,
  runtimePlatform = resolveSharpRuntimePlatform(),
  packageJsonPath,
  resolveBinding = (packageName) =>
    resolvePackageBinding(packageName, projectRoot),
  installPackages = (packages) =>
    installSharpPlatformPackages(packages, projectRoot),
} = {}) {
  if (!projectRoot) {
    throw new Error(
      "A project root is required to repair sharp native dependencies",
    );
  }

  const projectRequire = createRequire(join(projectRoot, "package.json"));
  const metadataPath =
    packageJsonPath || projectRequire.resolve("sharp/package.json");
  const sharpMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const packages = getSharpPlatformPackages(
    sharpMetadata.optionalDependencies || {},
    runtimePlatform,
  );

  if (packages.length === 0) {
    return { repaired: false, runtimePlatform, reason: "unsupported-runtime" };
  }

  if (resolveBinding(packages[0].name)) {
    return { repaired: false, runtimePlatform, reason: "binding-present" };
  }

  console.warn(
    `[sharp] Missing ${runtimePlatform} native binding; installing sharp's pinned platform packages`,
  );
  installPackages(packages);

  const bindingPath = resolveBinding(packages[0].name);
  if (!bindingPath) {
    throw new Error(
      `[sharp] Failed to install the ${runtimePlatform} native binding; image handling may be unavailable`,
    );
  }

  console.log(
    `[sharp] Repaired ${runtimePlatform} native binding at ${bindingPath}`,
  );
  return {
    repaired: true,
    runtimePlatform,
    packages,
    bindingPath,
  };
}
