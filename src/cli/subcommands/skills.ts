import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { parseFrontmatter } from "@/utils/frontmatter";

const HERMES_REPO_URL = "https://github.com/NousResearch/hermes-agent.git";
const HERMES_OPTIONAL_SKILLS_DIR = "optional-skills";

interface SkillSourceLocation {
  repoUrl: string;
  branch: string | null;
  subdir: string | null;
}

interface InstallResult {
  agentId: string;
  name: string;
  path: string;
  source: string;
}

interface ClawHubSourceLocation {
  slug: string;
  version: string | null;
}

const CLAWHUB_API_BASE_URL = "https://clawhub.ai/api/v1";

function printUsage(): void {
  console.log(
    `
Usage:
  letta install <skill> [--agent <id> | -n <name>] [--force]

Sources:
  official/<path>         Hermes official optional skill, e.g. official/finance/stocks
  clawhub/<slug>          ClawHub registry skill, e.g. clawhub/nano-banana-pro
  clawhub:<slug>          ClawHub registry skill, optionally <slug>@<version>
  https://github.com/...  GitHub repository, tree URL, or SKILL.md blob URL
  owner/repo/path         GitHub repo/path shorthand

Options:
  --agent <id>            Install into this agent's memfs repository
  --agent-id <id>         Alias for --agent
  -n, --name <name>       Install into the agent with this exact name
  --force                 Replace an existing skill with the same name
`.trim(),
  );
}

const SKILLS_OPTIONS = {
  help: { type: "boolean", short: "h" },
  agent: { type: "string" },
  "agent-id": { type: "string" },
  name: { type: "string", short: "n" },
  force: { type: "boolean" },
} as const;

function parseSkillsArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: SKILLS_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function isAgentId(value: string): boolean {
  return value.startsWith("agent-") || value.startsWith("agent_");
}

function paginatedItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[];
  const items = (page as { items?: unknown }).items;
  return Array.isArray(items) ? (items as T[]) : [];
}

async function findAgentsByName(name: string): Promise<AgentState[]> {
  const { getBackend } = await import("@/backend");
  const backend = getBackend();
  const page = await backend.listAgents({
    query_text: name,
    limit: 100,
  } as never);
  const normalizedName = name.toLowerCase();
  return paginatedItems<AgentState>(page).filter(
    (agent) => agent.name?.toLowerCase() === normalizedName,
  );
}

async function resolveAgentByName(name: string): Promise<string> {
  const matches = await findAgentsByName(name);
  if (matches.length === 0) {
    throw new Error(`No agent found with name "${name}".`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple agents found with name "${name}". Pass --agent with an agent id instead.`,
    );
  }
  const id = matches[0]?.id;
  if (!id) throw new Error(`Agent "${name}" did not include an id.`);
  return id;
}

async function listSelectableAgents(): Promise<AgentState[]> {
  const { getBackend } = await import("@/backend");
  const backend = getBackend();
  const page = await backend.listAgents({ limit: 100 } as never);
  return paginatedItems<AgentState>(page).filter((agent) => Boolean(agent.id));
}

async function promptForAgent(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Missing agent id. Pass --agent <id> or -n <agent name>.");
  }

  const agents = await listSelectableAgents();
  if (agents.length === 0) {
    throw new Error(
      "No agents found. Pass --agent <id> if the agent is hidden.",
    );
  }

  console.log("Select an agent:");
  agents.forEach((agent, index) => {
    console.log(`  ${index + 1}. ${agent.name || "Unnamed"} (${agent.id})`);
  });
  process.stdout.write("Enter number: ");

  const answer = await new Promise<string>((resolveAnswer) => {
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.once("data", (chunk) => {
      process.stdin.pause();
      resolveAnswer(String(chunk).trim());
    });
  });

  const index = Number.parseInt(answer, 10) - 1;
  const selected = agents[index];
  if (!selected?.id) {
    throw new Error("Invalid agent selection.");
  }
  return selected.id;
}

async function resolveAgentId(
  values: ReturnType<typeof parseSkillsArgs>["values"],
): Promise<string> {
  const explicitAgent = values.agent || values["agent-id"];
  if (typeof explicitAgent === "string" && explicitAgent.trim()) {
    return explicitAgent.trim();
  }

  if (typeof values.name === "string" && values.name.trim()) {
    const nameOrId = values.name.trim();
    if (isAgentId(nameOrId)) return nameOrId;
    return resolveAgentByName(nameOrId);
  }

  const envAgent = process.env.LETTA_AGENT_ID || process.env.AGENT_ID;
  if (envAgent?.trim()) return envAgent.trim();

  return promptForAgent();
}

export function parseGitHubSpecifier(
  input: string,
): SkillSourceLocation | null {
  const trimmed = input.trim();

  if (
    trimmed.startsWith("https://github.com/") ||
    trimmed.startsWith("http://github.com/")
  ) {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repoWithSuffix] = parts;
    const repo = repoWithSuffix?.replace(/\.git$/, "");
    if (!owner || !repo) return null;
    const repoUrl = `https://github.com/${owner}/${repo}.git`;
    const marker = parts[2];
    if ((marker === "tree" || marker === "blob") && parts.length >= 4) {
      const treePath = parts.slice(3).join("/");
      return {
        repoUrl,
        branch: null,
        subdir: marker === "blob" ? dirname(treePath) : treePath,
      };
    }
    return { repoUrl, branch: null, subdir: null };
  }

  const shorthand = trimmed.split("/").filter(Boolean);
  if (shorthand.length >= 3 && shorthand[0] !== "official") {
    return {
      repoUrl: `https://github.com/${shorthand[0]}/${shorthand[1]}.git`,
      branch: null,
      subdir: shorthand.slice(2).join("/"),
    };
  }

  if (shorthand.length === 2 && shorthand[0] !== "official") {
    return {
      repoUrl: `https://github.com/${shorthand[0]}/${shorthand[1]}.git`,
      branch: null,
      subdir: null,
    };
  }

  return null;
}

export function parseClawHubSpecifier(
  input: string,
): ClawHubSourceLocation | null {
  const trimmed = input.trim();
  let identifier: string | null = null;

  if (trimmed.startsWith("clawhub:")) {
    identifier = trimmed.slice("clawhub:".length);
  } else if (trimmed.startsWith("clawhub/")) {
    identifier = trimmed.slice("clawhub/".length);
  } else if (
    trimmed.startsWith("https://clawhub.ai/") ||
    trimmed.startsWith("http://clawhub.ai/")
  ) {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    const skillIndex = parts.indexOf("skills");
    const skillSlug = parts[skillIndex + 1];
    if (skillIndex >= 0 && skillSlug) {
      identifier = skillSlug;
    } else {
      identifier = parts.at(-1) ?? null;
    }
    const version = url.searchParams.get("version");
    if (identifier && version) identifier = `${identifier}@${version}`;
  }

  if (!identifier) return null;
  const cleaned = identifier.replace(/^\/+|\/+$/g, "");
  const finalSegment = cleaned.split("/").filter(Boolean).at(-1);
  if (!finalSegment) return null;

  const atIndex = finalSegment.lastIndexOf("@");
  const slug = atIndex >= 0 ? finalSegment.slice(0, atIndex) : finalSegment;
  const version = atIndex >= 0 ? finalSegment.slice(atIndex + 1) : null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) return null;
  if (version !== null && !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)) {
    return null;
  }
  return { slug, version: version || null };
}

function parseOfficialSpecifier(input: string): SkillSourceLocation | null {
  if (!input.startsWith("official/")) return null;
  const relativePath = input
    .slice("official/".length)
    .replace(/^\/+|\/+$/g, "");
  if (!relativePath || relativePath.includes("..")) return null;
  return {
    repoUrl: HERMES_REPO_URL,
    branch: null,
    subdir: `${HERMES_OPTIONAL_SKILLS_DIR}/${relativePath}`,
  };
}

async function execFile(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
) {
  const { execFile: execFileCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(execFileCb)(command, args, options);
}

async function resolveBranchAndSubdir(
  location: SkillSourceLocation,
): Promise<SkillSourceLocation> {
  if (!location.subdir) return location;

  const { stdout } = await execFile(
    "git",
    ["ls-remote", "--heads", location.repoUrl],
    {
      timeout: 60_000,
    },
  );
  const branches = stdout
    .split("\n")
    .map((line) => line.match(/refs\/heads\/(.+)$/)?.[1])
    .filter((branch): branch is string => Boolean(branch))
    .sort((a, b) => b.length - a.length);

  for (const branch of branches) {
    if (location.subdir === branch) {
      return { ...location, branch, subdir: null };
    }
    if (location.subdir.startsWith(`${branch}/`)) {
      return {
        ...location,
        branch,
        subdir: location.subdir.slice(branch.length + 1),
      };
    }
  }

  return location;
}

async function cloneSkillSource(
  location: SkillSourceLocation,
): Promise<{ tmpDir: string; sourceDir: string }> {
  const resolvedLocation = await resolveBranchAndSubdir(location);
  const tmpDir = mkdtempSync(join(tmpdir(), "letta-skill-install-"));
  const args = ["clone", "--depth", "1"];
  if (resolvedLocation.branch) {
    args.push("--branch", resolvedLocation.branch);
  }
  args.push(resolvedLocation.repoUrl, tmpDir);
  await execFile("git", args, { timeout: 120_000 });

  const sourceDir = resolvedLocation.subdir
    ? join(tmpDir, resolvedLocation.subdir)
    : tmpDir;
  return { tmpDir, sourceDir };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }
  return response.json();
}

async function resolveClawHubVersion(
  location: ClawHubSourceLocation,
): Promise<string> {
  if (location.version) return location.version;

  const skillData = await fetchJson(
    `${CLAWHUB_API_BASE_URL}/skills/${encodeURIComponent(location.slug)}`,
  );
  if (!skillData || typeof skillData !== "object") {
    throw new Error(`ClawHub skill not found: ${location.slug}`);
  }

  const data = skillData as {
    latestVersion?: { version?: unknown };
    skill?: { latestVersion?: { version?: unknown }; tags?: unknown };
    tags?: unknown;
  };
  const latestVersion = data.latestVersion ?? data.skill?.latestVersion;
  if (typeof latestVersion?.version === "string" && latestVersion.version) {
    return latestVersion.version;
  }

  const tags = data.skill?.tags ?? data.tags;
  if (
    tags &&
    typeof tags === "object" &&
    typeof (tags as { latest?: unknown }).latest === "string"
  ) {
    return (tags as { latest: string }).latest;
  }

  throw new Error(
    `Could not resolve latest ClawHub version for ${location.slug}`,
  );
}

function assertSafeZipMember(name: string): void {
  const normalized = name.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (
    !normalized ||
    normalized.startsWith("/") ||
    parts.length === 0 ||
    parts.some((part) => part === "..") ||
    /^[A-Za-z]:$/.test(parts[0] ?? "")
  ) {
    throw new Error(`Unsafe path in ClawHub ZIP: ${name}`);
  }
}

async function downloadClawHubSkillSource(
  location: ClawHubSourceLocation,
): Promise<{ tmpDir: string; sourceDir: string }> {
  const version = await resolveClawHubVersion(location);
  const tmpDir = mkdtempSync(join(tmpdir(), "letta-clawhub-skill-"));
  const zipPath = join(tmpDir, "skill.zip");
  const sourceDir = join(tmpDir, "skill");
  await mkdir(sourceDir, { recursive: true });

  const url = new URL(`${CLAWHUB_API_BASE_URL}/download`);
  url.searchParams.set("slug", location.slug);
  url.searchParams.set("version", version);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `ClawHub download failed for ${location.slug}@${version}: ${response.status}`,
    );
  }
  writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));

  const { stdout } = await execFile("unzip", ["-Z1", zipPath], {
    timeout: 30_000,
  });
  const members = stdout.split("\n").filter(Boolean);
  if (members.length === 0) {
    throw new Error(
      `ClawHub download was empty for ${location.slug}@${version}`,
    );
  }
  members.forEach(assertSafeZipMember);

  await execFile("unzip", ["-q", zipPath, "-d", sourceDir], {
    timeout: 30_000,
  });

  return { tmpDir, sourceDir };
}

function assertInside(parent: string, child: string): void {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  if (
    childPath !== parentPath &&
    !childPath.startsWith(`${parentPath}${sep}`)
  ) {
    throw new Error(`Resolved path is outside target directory: ${child}`);
  }
}

function sanitizeSkillName(name: string): string {
  const trimmed = name.trim();
  if (
    !/^[A-Za-z0-9._-]+$/.test(trimmed) ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    throw new Error(`Invalid skill name "${name}".`);
  }
  return trimmed;
}

function getSkillName(sourceDir: string): string {
  const skillMd = readFileSync(join(sourceDir, "SKILL.md"), "utf8");
  const { frontmatter } = parseFrontmatter(skillMd);
  const frontmatterName = frontmatter.name;
  const name =
    typeof frontmatterName === "string" && frontmatterName.trim()
      ? frontmatterName
      : basename(sourceDir);
  return sanitizeSkillName(name);
}

export async function installSkillDirectory(params: {
  sourceDir: string;
  memoryDir: string;
  force?: boolean;
}): Promise<{ name: string; path: string }> {
  const sourceDir = resolve(params.sourceDir);
  const memoryDir = resolve(params.memoryDir);
  const skillMdPath = join(sourceDir, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    throw new Error("No SKILL.md found in the skill directory.");
  }
  if (!statSync(sourceDir).isDirectory()) {
    throw new Error(`Skill source is not a directory: ${sourceDir}`);
  }

  const name = getSkillName(sourceDir);
  const skillsDir = join(memoryDir, "skills");
  const targetPath = join(skillsDir, name);
  assertInside(skillsDir, targetPath);

  if (existsSync(targetPath)) {
    if (!params.force) {
      throw new Error(
        `Skill "${name}" already exists at ${targetPath}. Re-run with --force to replace it.`,
      );
    }
    rmSync(targetPath, { recursive: true, force: true });
  }

  await mkdir(skillsDir, { recursive: true });
  cpSync(sourceDir, targetPath, {
    recursive: true,
    filter: (source) => basename(source) !== ".git",
  });
  return { name, path: normalize(targetPath) };
}

async function installSkill(
  specifier: string,
  agentId: string,
  force: boolean,
): Promise<InstallResult> {
  const clawHubSource = parseClawHubSpecifier(specifier);
  const gitSource = clawHubSource
    ? null
    : (parseOfficialSpecifier(specifier) ?? parseGitHubSpecifier(specifier));
  if (!gitSource && !clawHubSource) {
    throw new Error(`Unsupported skill source: ${specifier}`);
  }

  const { ensureLocalMemfsCheckout, getScopedMemoryFilesystemRoot } =
    await import("@/agent/memory-filesystem");
  await ensureLocalMemfsCheckout(agentId);
  const memoryDir = getScopedMemoryFilesystemRoot(agentId);
  let tmpDir: string | null = null;
  try {
    const downloaded = gitSource
      ? await cloneSkillSource(gitSource)
      : await downloadClawHubSkillSource(
          clawHubSource as ClawHubSourceLocation,
        );
    tmpDir = downloaded.tmpDir;
    const sourceDir = resolve(downloaded.sourceDir);
    assertInside(tmpDir, sourceDir);
    if (!existsSync(sourceDir)) {
      const missingPath = gitSource?.subdir || clawHubSource?.slug || ".";
      throw new Error(`Skill path not found: ${missingPath}`);
    }
    const result = await installSkillDirectory({ sourceDir, memoryDir, force });
    return { agentId, source: specifier, ...result };
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function runInstall(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseSkillsArgs>;
  try {
    parsed = parseSkillsArgs(argv);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    return 1;
  }

  const [specifier] = parsed.positionals;
  if (parsed.values.help || !specifier || specifier === "help") {
    printUsage();
    return 0;
  }

  if (parsed.positionals.length > 1) {
    console.error(`Unexpected argument: ${parsed.positionals[1]}`);
    printUsage();
    return 1;
  }

  try {
    const { settingsManager } = await import("@/settings-manager");
    await settingsManager.initialize();
    const agentId = await resolveAgentId(parsed.values);
    const result = await installSkill(
      specifier,
      agentId,
      Boolean(parsed.values.force),
    );
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runInstallSubcommand(argv: string[]): Promise<number> {
  return runInstall(argv);
}

export async function runSkillsSubcommand(argv: string[]): Promise<number> {
  const [action, ...rest] = argv;
  if (action === "install") {
    return runInstall(rest);
  }
  if (!action || action === "help" || action === "--help" || action === "-h") {
    printUsage();
    return 0;
  }
  console.error(`Unknown action: ${action}`);
  printUsage();
  return 1;
}
