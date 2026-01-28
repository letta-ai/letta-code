import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getShellEnv } from "./shellEnv.js";
import { validateRequiredParams } from "./validation.js";

interface SgPredicateRegistryApplyOpsArgs {
  ops: Array<Record<string, unknown>>;
  predicate_spec_path?: string;
  predicate_alias_path?: string;
}

type SgPredicateRegistryApplyOpsResult =
  | { ok: true }
  | {
      ok: false;
      errors: string[];
    };

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findRepoRootWithMarker(
  startDir: string,
  markerRelPath: string,
): Promise<string | null> {
  let dir = startDir;
  for (let i = 0; i < 25; i++) {
    const candidate = path.join(dir, markerRelPath);
    if (await pathExists(candidate)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

async function runProcess(
  executable: string,
  args: string[],
  opts: { cwd: string },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: opts.cwd,
      env: getShellEnv(),
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (buf: Buffer) => {
      stdout += buf.toString("utf-8");
    });

    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString("utf-8");
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

async function runPythonWithFallback(
  args: { scriptPath: string; scriptArgs: string[]; cwd: string },
): Promise<{ stdout: string; stderr: string; exitCode: number | null; python: string }> {
  const candidates = ["python", "python3"];
  let lastErr: unknown = null;

  for (const python of candidates) {
    try {
      const res = await runProcess(python, [args.scriptPath, ...args.scriptArgs], {
        cwd: args.cwd,
      });
      return { ...res, python };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e && e.code === "ENOENT") {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `No Python interpreter found (tried: ${candidates.join(", ")}). Last error: ${String(lastErr)}`,
  );
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    // ignore
  }
}

async function safeRmDir(p: string): Promise<void> {
  try {
    await fs.rm(p, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export async function sg_predicate_registry_apply_ops(
  args: SgPredicateRegistryApplyOpsArgs,
): Promise<SgPredicateRegistryApplyOpsResult & { meta?: Record<string, unknown> }> {
  validateRequiredParams(args, ["ops"], "SgPredicateRegistryApplyOps");

  const userCwd = process.env.USER_CWD || process.cwd();

  const repoRoot = await findRepoRootWithMarker(
    userCwd,
    path.join("tools", "sg", "apply_predicate_registry_ops.py"),
  );
  if (!repoRoot) {
    throw new Error(
      `Could not locate smarty-graph repo root from cwd: ${userCwd}. Expected to find tools/sg/apply_predicate_registry_ops.py in this directory or one of its parents.`,
    );
  }

  const defaultSpec = path.join(repoRoot, "registries", "predicate_spec_v1.json");
  const defaultAlias = path.join(repoRoot, "registries", "predicate_alias_v1.json");

  const specAbs = args.predicate_spec_path
    ? path.isAbsolute(args.predicate_spec_path)
      ? args.predicate_spec_path
      : path.resolve(userCwd, args.predicate_spec_path)
    : defaultSpec;

  const aliasAbs = args.predicate_alias_path
    ? path.isAbsolute(args.predicate_alias_path)
      ? args.predicate_alias_path
      : path.resolve(userCwd, args.predicate_alias_path)
    : defaultAlias;

  const repoPrefix = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  if (!specAbs.startsWith(repoPrefix) || !aliasAbs.startsWith(repoPrefix)) {
    throw new Error(
      `Registry paths must be inside the repo. repo_root=${repoRoot} predicate_spec_path=${specAbs} predicate_alias_path=${aliasAbs}`,
    );
  }

  if (!(await pathExists(specAbs))) {
    throw new Error(`Predicate spec file does not exist: ${specAbs}`);
  }
  if (!(await pathExists(aliasAbs))) {
    throw new Error(`Predicate alias file does not exist: ${aliasAbs}`);
  }

  // Prepare a scratch workspace in the same directory as the registries
  // so we can swap files in atomically on success.
  const registriesDir = path.dirname(specAbs);
  const tmpDir = await fs.mkdtemp(path.join(registriesDir, ".tmp-sg-predicate-registry-"));

  const tmpSpec = path.join(tmpDir, path.basename(specAbs));
  const tmpAlias = path.join(tmpDir, path.basename(aliasAbs));
  const opsPath = path.join(tmpDir, "predicate_registry_ops.json");

  const bakSpec = specAbs + ".bak";
  const bakAlias = aliasAbs + ".bak";

  try {
    await fs.copyFile(specAbs, tmpSpec);
    await fs.copyFile(aliasAbs, tmpAlias);

    const opsBatch: Record<string, unknown> = {
      ops_version: "v1",
      ops: args.ops,
    };
    await fs.writeFile(opsPath, JSON.stringify(opsBatch, null, 2) + "\n", "utf-8");

    const scriptPath = path.join(repoRoot, "tools", "sg", "apply_predicate_registry_ops.py");

    const { stdout, stderr, exitCode, python } = await runPythonWithFallback({
      scriptPath,
      scriptArgs: [
        opsPath,
        "--predicate-spec",
        tmpSpec,
        "--predicate-alias",
        tmpAlias,
      ],
      cwd: repoRoot,
    });

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return {
        ok: false,
        errors: [
          "Failed to parse JSON output from apply_predicate_registry_ops.py",
          `exit_code=${String(exitCode)}`,
          `python=${python}`,
          `stdout=${stdout.trim()}`,
          ...(stderr.trim() ? [`stderr=${stderr.trim()}`] : []),
        ],
      };
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "ok" in parsed &&
      (parsed as Record<string, unknown>).ok === true
    ) {
      // Atomic swap: move originals to .bak, move tmp files into place.
      // Roll back on any failure.
      await safeUnlink(bakSpec);
      await safeUnlink(bakAlias);

      try {
        await fs.rename(specAbs, bakSpec);
        await fs.rename(aliasAbs, bakAlias);

        await fs.rename(tmpSpec, specAbs);
        await fs.rename(tmpAlias, aliasAbs);

        await safeUnlink(bakSpec);
        await safeUnlink(bakAlias);

        return {
          ok: true,
          meta: { python, exit_code: exitCode },
        };
      } catch (swapErr) {
        // Best-effort rollback.
        try {
          if (!(await pathExists(specAbs)) && (await pathExists(bakSpec))) {
            await fs.rename(bakSpec, specAbs);
          }
        } catch {
          // ignore
        }
        try {
          if (!(await pathExists(aliasAbs)) && (await pathExists(bakAlias))) {
            await fs.rename(bakAlias, aliasAbs);
          }
        } catch {
          // ignore
        }
        throw swapErr;
      }
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "ok" in parsed &&
      (parsed as Record<string, unknown>).ok === false &&
      Array.isArray((parsed as Record<string, unknown>).errors)
    ) {
      return {
        ok: false,
        errors: (parsed as Record<string, unknown>).errors as string[],
        meta: { python, exit_code: exitCode },
      };
    }

    return {
      ok: false,
      errors: [
        "Unexpected output from apply_predicate_registry_ops.py",
        `exit_code=${String(exitCode)}`,
        `python=${python}`,
        `stdout=${stdout.trim()}`,
        ...(stderr.trim() ? [`stderr=${stderr.trim()}`] : []),
      ],
    };
  } finally {
    // Cleanup scratch dir (even on success, tmp files were renamed out)
    await safeRmDir(tmpDir);

    // If swap failed part-way, .bak files may remain; keep them for safety.
    // The user can inspect and delete them manually.
  }
}
