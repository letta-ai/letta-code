import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getShellEnv } from "./shellEnv.js";
import { validateRequiredParams } from "./validation.js";

interface SgGoldPatchApplyOpsArgs {
  proposals_path: string;
  source_path?: string;
  ops: Array<Record<string, unknown>>;
}

type SgGoldPatchApplyOpsResult =
  | {
      ok: true;
    }
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
      // Try next if python executable not found.
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

export async function sg_gold_patch_apply_ops(
  args: SgGoldPatchApplyOpsArgs,
): Promise<SgGoldPatchApplyOpsResult & { meta?: Record<string, unknown> }> {
  validateRequiredParams(args, ["proposals_path", "ops"], "SgGoldPatchApplyOps");

  const userCwd = process.env.USER_CWD || process.cwd();

  const repoRoot = await findRepoRootWithMarker(
    userCwd,
    path.join("tools", "sg", "apply_gold_proposals_patch_ops.py"),
  );
  if (!repoRoot) {
    throw new Error(
      `Could not locate smarty-graph repo root from cwd: ${userCwd}. Expected to find tools/sg/apply_gold_proposals_patch_ops.py in this directory or one of its parents.`,
    );
  }

  const proposalsAbs = path.isAbsolute(args.proposals_path)
    ? args.proposals_path
    : path.resolve(userCwd, args.proposals_path);

  if (!(await pathExists(proposalsAbs))) {
    throw new Error(`Proposals file does not exist: ${proposalsAbs}`);
  }

  // Normalize to repo-relative paths for the Python applier.
  const repoPrefix = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  if (!proposalsAbs.startsWith(repoPrefix)) {
    throw new Error(
      `proposals_path must be inside the repo. proposals_path=${proposalsAbs} repo_root=${repoRoot}`,
    );
  }
  const proposalsRel = path.relative(repoRoot, proposalsAbs);

  let sourceRel: string | undefined;
  if (args.source_path) {
    const sourceAbs = path.isAbsolute(args.source_path)
      ? args.source_path
      : path.resolve(userCwd, args.source_path);
    if (!sourceAbs.startsWith(repoPrefix)) {
      throw new Error(
        `source_path must be inside the repo. source_path=${sourceAbs} repo_root=${repoRoot}`,
      );
    }
    sourceRel = path.relative(repoRoot, sourceAbs);
  }

  const opsBatch: Record<string, unknown> = {
    ops_version: "v1",
    target: {
      proposals_path: proposalsRel,
      ...(sourceRel ? { source_path: sourceRel } : {}),
    },
    ops: args.ops,
  };

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "letta-sg-gold-patch-"));
  const opsPath = path.join(tmpDir, "gold_patch_ops.json");

  try {
    await fs.writeFile(opsPath, JSON.stringify(opsBatch, null, 2) + "\n", "utf-8");

    const scriptPath = path.join(
      repoRoot,
      "tools",
      "sg",
      "apply_gold_proposals_patch_ops.py",
    );

    const { stdout, stderr, exitCode, python } = await runPythonWithFallback({
      scriptPath,
      scriptArgs: [opsPath],
      cwd: repoRoot,
    });

    // The Python tool prints a JSON object on stdout for both success and failure.
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // If parsing fails, treat as error and include raw output.
      return {
        ok: false,
        errors: [
          "Failed to parse JSON output from apply_gold_proposals_patch_ops.py",
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
      return {
        ok: true,
        meta: {
          python,
          exit_code: exitCode,
        },
      };
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
        meta: {
          python,
          exit_code: exitCode,
        },
      };
    }

    return {
      ok: false,
      errors: [
        "Unexpected output from apply_gold_proposals_patch_ops.py",
        `exit_code=${String(exitCode)}`,
        `python=${python}`,
        `stdout=${stdout.trim()}`,
        ...(stderr.trim() ? [`stderr=${stderr.trim()}`] : []),
      ],
    };
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}
