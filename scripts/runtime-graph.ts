import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RUNTIME_GRAPH_PROTOCOL = 1;
export const RUNTIME_GRAPH_NPM_VERSION = "12.2.0";
export const RUNTIME_GRAPH_BUN_VERSION = "1.3.14";
const PACKAGE_PATH = new URL("../package.json", import.meta.url);
const SHRINKWRAP_PATH = new URL("../npm-shrinkwrap.json", import.meta.url);
const REGISTRY_HOST = "registry.npmjs.org";
const SHA512_PATTERN = /^sha512-([A-Za-z0-9+/]+={0,2})$/;

type PackageManifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  lettaRuntimeGraphProtocol?: number;
  lettaRuntimeGraphSha512?: string;
  [key: string]: unknown;
};

type LockEntry = {
  version?: string;
  resolved?: string;
  integrity?: string;
  optional?: boolean;
  os?: string[];
  cpu?: string[];
  link?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type DependencyLock = {
  name?: string;
  version?: string;
  lockfileVersion?: number;
  packages?: Record<string, LockEntry>;
};

type CanonicalGraphEntry = {
  location: string;
  version: string;
  resolved: string;
  integrity: string;
  optional: boolean;
  os: string[];
  cpu: string[];
};

function hasSha512Integrity(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = SHA512_PATTERN.exec(value);
  return Boolean(match && Buffer.from(match[1], "base64").byteLength === 64);
}

export function canonicalRuntimeGraph(
  lock: DependencyLock,
): CanonicalGraphEntry[] {
  if (lock.lockfileVersion !== 3 || !lock.packages) {
    throw new Error(
      "npm-shrinkwrap.json must contain a lockfileVersion 3 package graph",
    );
  }

  const graph: CanonicalGraphEntry[] = [];
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    if (entry.link || typeof entry.version !== "string") {
      throw new Error(`Dependency graph entry ${location} is not immutable`);
    }
    if (typeof entry.resolved !== "string") {
      throw new Error(
        `Dependency graph entry ${location} has no resolved artifact`,
      );
    }
    const resolved = new URL(entry.resolved);
    if (
      resolved.protocol !== "https:" ||
      resolved.hostname !== REGISTRY_HOST ||
      resolved.username ||
      resolved.password ||
      resolved.port ||
      resolved.search ||
      resolved.hash
    ) {
      throw new Error(`Dependency graph entry ${location} is not canonical`);
    }
    if (!hasSha512Integrity(entry.integrity)) {
      throw new Error(
        `Dependency graph entry ${location} lacks SHA-512 integrity`,
      );
    }
    graph.push({
      location,
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
      optional: entry.optional === true,
      os: Array.isArray(entry.os) ? entry.os : [],
      cpu: Array.isArray(entry.cpu) ? entry.cpu : [],
    });
  }

  graph.sort((left, right) => left.location.localeCompare(right.location));
  return graph;
}

export function runtimeGraphDigest(lock: DependencyLock): string {
  const graph = canonicalRuntimeGraph(lock);
  return `sha512-${createHash("sha512").update(JSON.stringify(graph)).digest("base64")}`;
}

function productionManifest(manifest: PackageManifest): PackageManifest {
  return {
    name: manifest.name,
    version: manifest.version,
    dependencies: manifest.dependencies ?? {},
    optionalDependencies: manifest.optionalDependencies ?? {},
    engines: manifest.engines ?? {},
  };
}

function sameRecord(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  const entries = (value: Record<string, string> | undefined) =>
    Object.entries(value ?? {}).sort(([leftKey], [rightKey]) =>
      leftKey.localeCompare(rightKey),
    );
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

export function verifyRuntimeGraph(
  manifest: PackageManifest,
  lock: DependencyLock,
): string {
  const root = lock.packages?.[""];
  if (
    lock.name !== manifest.name ||
    lock.version !== manifest.version ||
    root?.name !== manifest.name ||
    root?.version !== manifest.version ||
    !sameRecord(root.dependencies, manifest.dependencies) ||
    !sameRecord(root.optionalDependencies, manifest.optionalDependencies)
  ) {
    throw new Error("npm-shrinkwrap.json root does not match package.json");
  }
  const digest = runtimeGraphDigest(lock);
  if (
    manifest.lettaRuntimeGraphProtocol !== RUNTIME_GRAPH_PROTOCOL ||
    manifest.lettaRuntimeGraphSha512 !== digest
  ) {
    throw new Error(
      `package.json runtime graph declaration is stale (expected ${digest})`,
    );
  }
  return digest;
}

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

async function runNpm(args: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      args,
      {
        cwd,
        stdio: ["ignore", "pipe", "inherit"],
        env: {
          ...process.env,
          npm_config_registry: "https://registry.npmjs.org",
          npm_config_ignore_scripts: "true",
          npm_config_audit: "false",
          npm_config_fund: "false",
        },
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(`npm exited with ${signal ?? code ?? "unknown status"}`),
        );
    });
  });
}

async function runBun(args: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "bun.exe" : "bun",
      args,
      {
        cwd,
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(`bun exited with ${signal ?? code ?? "unknown status"}`),
        );
    });
  });
}

async function assertExactToolchain(cwd: string): Promise<void> {
  const [npmVersion, bunVersion] = await Promise.all([
    runNpm(["--version"], cwd),
    runBun(["--version"], cwd),
  ]);
  if (npmVersion !== RUNTIME_GRAPH_NPM_VERSION) {
    throw new Error(
      `runtime graph generation requires npm ${RUNTIME_GRAPH_NPM_VERSION}, found ${npmVersion}`,
    );
  }
  if (bunVersion !== RUNTIME_GRAPH_BUN_VERSION) {
    throw new Error(
      `runtime graph generation requires Bun ${RUNTIME_GRAPH_BUN_VERSION}, found ${bunVersion}`,
    );
  }
}

async function generateRuntimeGraph(): Promise<string> {
  const manifest = await readJson<PackageManifest>(PACKAGE_PATH);
  const staging = await mkdtemp(join(tmpdir(), "letta-runtime-graph-"));
  const runtimeRoot = join(staging, "runtime");
  const installerRoot = join(staging, "installer");
  try {
    await assertExactToolchain(staging);
    await Promise.all([
      mkdir(runtimeRoot, { recursive: true }),
      mkdir(installerRoot, { recursive: true }),
    ]);
    await writeFile(
      join(runtimeRoot, "package.json"),
      `${JSON.stringify(productionManifest(manifest), null, 2)}\n`,
    );
    try {
      const existing = await readFile(SHRINKWRAP_PATH);
      await writeFile(join(runtimeRoot, "npm-shrinkwrap.json"), existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const packOutput = await runBun(
      [
        "pm",
        "pack",
        "--quiet",
        "--ignore-scripts",
        "--destination",
        installerRoot,
      ],
      runtimeRoot,
    );
    const packedPath = packOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.endsWith(".tgz"));
    const tarball = packedPath?.split(/[\\/]/).pop();
    if (!tarball)
      throw new Error("bun pm pack did not produce a runtime tarball");
    await writeFile(
      join(installerRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            [manifest.name]: `file:${tarball}`,
          },
        },
        null,
        2,
      )}\n`,
    );
    await runNpm(
      [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      installerRoot,
    );
    const outerLock = JSON.parse(
      await readFile(join(installerRoot, "package-lock.json"), "utf8"),
    ) as DependencyLock;
    const runtimeLocation = `node_modules/${manifest.name}`;
    const packages = { ...outerLock.packages };
    delete packages[""];
    delete packages[runtimeLocation];
    packages[""] = {
      name: manifest.name,
      version: manifest.version,
      dependencies: manifest.dependencies ?? {},
      optionalDependencies: manifest.optionalDependencies ?? {},
    };
    const lock: DependencyLock = {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      packages,
    };
    const digest = runtimeGraphDigest(lock);
    manifest.lettaRuntimeGraphProtocol = RUNTIME_GRAPH_PROTOCOL;
    manifest.lettaRuntimeGraphSha512 = digest;
    await writeFile(SHRINKWRAP_PATH, `${JSON.stringify(lock, null, 2)}\n`);
    await writeFile(PACKAGE_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    return digest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function verifyFiles(): Promise<string> {
  const [manifest, lock] = await Promise.all([
    readJson<PackageManifest>(PACKAGE_PATH),
    readJson<DependencyLock>(SHRINKWRAP_PATH),
  ]);
  return verifyRuntimeGraph(manifest, lock);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "verify";
  const digest =
    command === "generate"
      ? await generateRuntimeGraph()
      : command === "verify"
        ? await verifyFiles()
        : (() => {
            throw new Error(`Unknown runtime graph command: ${command}`);
          })();
  console.log(`Runtime dependency graph verified: ${digest}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
