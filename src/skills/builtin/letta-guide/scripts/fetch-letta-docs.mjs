#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const DEFAULT_DOCS_URL = "https://docs.letta.com/llms.txt";
const CACHE_DIRECTORY_NAME = "letta-docs-cache";
const DOCUMENT_NAME = "letta-docs.md";
const OUTLINE_NAME = "letta-docs.outline.md";
const USER_AGENT = "letta-guide";
const runFile = promisify(execFile);

class DocsFetchError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "DocsFetchError";
  }
}

function bodyDigest(body) {
  return createHash("md5").update(body).digest("hex");
}

function hasProxyEnvironment() {
  return ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].some(
    (key) => Boolean(process.env[key]),
  );
}

function temporaryFile(directory, extension) {
  return path.join(
    directory,
    `.letta-docs-${process.pid}-${Date.now()}-${randomBytes(5).toString("hex")}${extension}`,
  );
}

function parseHeaderDump(raw) {
  const responseBlocks = raw
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n\n+/)
    .filter((block) => block.startsWith("HTTP/"));
  const finalBlock = responseBlocks.at(-1);
  if (!finalBlock) {
    throw new DocsFetchError("curl returned no HTTP response headers.");
  }

  const [statusLine, ...lines] = finalBlock.split("\n");
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(statusLine)?.[1]);
  if (!Number.isInteger(status)) {
    throw new DocsFetchError(
      `curl returned an invalid status line: ${statusLine}`,
    );
  }

  const headers = new Map();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    headers.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim(),
    );
  }
  return { headers, status };
}

async function curlRequest(url, method, cacheDirectory, timeoutMs) {
  const headersFile = temporaryFile(cacheDirectory, ".headers");
  const bodyFile = temporaryFile(cacheDirectory, ".body");
  const executables =
    process.platform === "win32" ? ["curl.exe", "curl"] : ["curl"];
  const argumentsList = [
    "--silent",
    "--show-error",
    "--location",
    "--dump-header",
    headersFile,
    "--output",
    bodyFile,
    "--user-agent",
    USER_AGENT,
    "--max-time",
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    ...(method === "HEAD" ? ["--head"] : ["--request", method]),
    url,
  ];

  let failure;
  for (const executable of executables) {
    try {
      await runFile(executable, argumentsList, { windowsHide: true });
      const [rawHeaders, body] = await Promise.all([
        readFile(headersFile, "utf8"),
        readFile(bodyFile, "utf8"),
      ]);
      return { ...parseHeaderDump(rawHeaders), body };
    } catch (error) {
      failure = error;
      if (error?.code !== "ENOENT") break;
    } finally {
      await Promise.all([
        rm(headersFile, { force: true }),
        rm(bodyFile, { force: true }),
      ]);
    }
  }
  throw new DocsFetchError(
    failure?.code === "ENOENT"
      ? "curl is unavailable in this environment."
      : `curl could not ${method} ${url}.`,
    failure,
  );
}

async function nodeRequest(url, method, _cacheDirectory, timeoutMs) {
  if (typeof fetch !== "function") {
    throw new DocsFetchError("Native fetch requires Node.js 18 or newer.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: controller.signal,
    });
    const headers = new Map();
    response.headers.forEach((value, key) => {
      headers.set(key.toLowerCase(), value);
    });
    return {
      body: method === "HEAD" ? "" : await response.text(),
      headers,
      status: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestDocument(url, method, cacheDirectory, timeoutMs) {
  const transports = hasProxyEnvironment()
    ? [curlRequest, nodeRequest]
    : [nodeRequest, curlRequest];
  let failure;
  for (const transport of transports) {
    try {
      const result = await transport(url, method, cacheDirectory, timeoutMs);
      if (result.status < 200 || result.status >= 300) {
        throw new DocsFetchError(
          `${method} ${url} failed with HTTP ${result.status}.`,
        );
      }
      return result;
    } catch (error) {
      failure = error;
    }
  }
  throw new DocsFetchError(`${method} ${url} could not be fetched.`, failure);
}

function digestFromEtag(headers) {
  const etag = headers.get("etag") ?? "";
  const digest = /^(?:W\/)?"([a-f0-9]{32})"$/i.exec(etag)?.[1];
  if (!digest) {
    throw new DocsFetchError(
      "Letta docs response is missing a content-MD5 ETag.",
    );
  }
  return digest.toLowerCase();
}

async function nearestExistingDirectory(candidate) {
  let current = path.resolve(candidate);
  while (true) {
    try {
      return (await stat(current)).isDirectory() ? current : null;
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function writableCacheDirectory(candidate) {
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  try {
    const existing = await stat(resolved);
    if (!existing.isDirectory()) return null;
  } catch (error) {
    if (error?.code !== "ENOENT") return null;
  }
  const existingParent = await nearestExistingDirectory(resolved);
  if (!existingParent) return null;
  try {
    await access(existingParent, fsConstants.W_OK | fsConstants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

async function selectCacheDirectory(override) {
  if (override) return writableCacheDirectory(override);
  const candidates = [process.env.TMPDIR, process.env.TEMP, process.env.TMP]
    .filter(Boolean)
    .map((directory) => path.join(directory, CACHE_DIRECTORY_NAME));
  if (process.platform !== "win32") {
    candidates.push(
      path.join("/private/tmp", CACHE_DIRECTORY_NAME),
      path.join("/tmp", CACHE_DIRECTORY_NAME),
    );
  }
  for (const candidate of new Set(candidates)) {
    const usable = await writableCacheDirectory(candidate);
    if (usable) return usable;
  }
  return null;
}

async function atomicWrite(destination, contents) {
  const temporary = temporaryFile(
    path.dirname(destination),
    `.${path.basename(destination)}.tmp`,
  );
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, destination);
}

function createOutline(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const entries = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const heading = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (!heading) return;
    entries.push({
      level: heading[1].length,
      title: heading[2]
        .replace(/\s+#+\s*$/, "")
        .replace(/\s+/g, " ")
        .trim(),
      start: index + 1,
      end: lines.length,
    });
  });
  entries.forEach((entry, index) => {
    const nextPeer = entries
      .slice(index + 1)
      .find((candidate) => candidate.level <= entry.level);
    if (nextPeer) entry.end = nextPeer.start - 1;
  });

  const lowestLevel = entries.length
    ? Math.min(...entries.map((entry) => entry.level))
    : 2;
  const text = entries.length
    ? entries
        .map(
          (entry) =>
            `${"  ".repeat(entry.level - lowestLevel)}- ${entry.title} (lines ${entry.start}-${entry.end})`,
        )
        .join("\n")
    : "No markdown headings found.";
  return {
    headingCount: entries.length,
    lineCount: lines.length,
    markdown: `# Letta Docs Outline\n\n${text}\n`,
  };
}

async function cachedBody(documentPath, expectedDigest) {
  try {
    const body = await readFile(documentPath, "utf8");
    return bodyDigest(body) === expectedDigest ? body : null;
  } catch {
    return null;
  }
}

async function fetchLettaDocs({
  docsUrl = DEFAULT_DOCS_URL,
  cacheDir,
  timeoutMs = 30000,
} = {}) {
  const selectedCache = await selectCacheDirectory(cacheDir);
  if (!selectedCache) {
    throw new DocsFetchError(
      "No writable docs cache is available; pass --cache-dir to override.",
    );
  }
  await mkdir(selectedCache, { recursive: true });

  const documentPath = path.join(selectedCache, DOCUMENT_NAME);
  const outlinePath = path.join(selectedCache, OUTLINE_NAME);
  const head = await requestDocument(docsUrl, "HEAD", selectedCache, timeoutMs);
  const expectedDigest = digestFromEtag(head.headers);
  let body = await cachedBody(documentPath, expectedDigest);
  const cacheStatus = body === null ? "updated" : "hit";

  if (body === null) {
    const get = await requestDocument(docsUrl, "GET", selectedCache, timeoutMs);
    const getDigest = digestFromEtag(get.headers);
    if (getDigest !== expectedDigest) {
      throw new DocsFetchError(
        `ETag changed between HEAD and GET for ${docsUrl}.`,
      );
    }
    if (bodyDigest(get.body) !== expectedDigest) {
      throw new DocsFetchError(
        `ETag did not match the fetched body for ${docsUrl}.`,
      );
    }
    body = get.body;
    await atomicWrite(documentPath, body);
  }

  const outline = createOutline(body);
  await atomicWrite(outlinePath, outline.markdown);
  return {
    outline: outline.markdown,
    status: {
      docsUrl,
      etagMd5: expectedDigest,
      fetchedMd5: bodyDigest(body),
      contentMatchesEtag: true,
      cacheStatus,
      cacheDir: selectedCache,
      docsPath: documentPath,
      outlinePath,
      checkedAt: new Date().toISOString(),
      lineCount: outline.lineCount,
      headingCount: outline.headingCount,
    },
  };
}

function parseArguments(argv) {
  const result = {
    docsUrl: DEFAULT_DOCS_URL,
    cacheDir: undefined,
    timeoutMs: 30000,
    statusJson: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--docs-url") result.docsUrl = argv[++index];
    else if (value === "--cache-dir") result.cacheDir = argv[++index];
    else if (value === "--timeout-ms") result.timeoutMs = Number(argv[++index]);
    else if (value === "--status-json") result.statusJson = true;
    else throw new DocsFetchError(`Unknown argument: ${value}`);
  }
  if (!result.docsUrl) throw new DocsFetchError("--docs-url cannot be empty.");
  if (!Number.isFinite(result.timeoutMs) || result.timeoutMs <= 0) {
    throw new DocsFetchError("--timeout-ms must be a positive number.");
  }
  return result;
}

function outputFor(status, outline) {
  return [
    `Docs path: ${status.docsPath}`,
    `Outline path: ${status.outlinePath}`,
    status.cacheStatus === "hit"
      ? "Docs status: local document was already current."
      : "Docs status: local document was updated.",
    "",
    outline,
  ].join("\n");
}

function errorChain(error) {
  const messages = [];
  let current = error;
  while (current) {
    messages.push(
      current instanceof Error
        ? `${current.name}: ${current.message}`
        : String(current),
    );
    current = current?.cause;
  }
  return messages.join("\nCaused by: ");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await fetchLettaDocs(options);
  process.stdout.write(outputFor(result.status, result.outline));
  if (options.statusJson) console.error(JSON.stringify(result.status));
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    if (hasProxyEnvironment()) {
      console.error(
        "Hint: proxy variables are set, so curl is tried before native fetch.",
      );
    } else if (typeof fetch !== "function") {
      console.error("Hint: install curl or use Node.js 18 or newer.");
    } else if (process.platform === "win32") {
      console.error("Hint: use a cache directory under %TEMP% or %TMP%.");
    }
    console.error("");
    console.error("Details:");
    console.error(errorChain(error));
    process.exitCode = 1;
  });
}

export { DEFAULT_DOCS_URL, createOutline, fetchLettaDocs };
