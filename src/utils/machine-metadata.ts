import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";

/** Descriptive computer specs only. Never send raw probe output or identifiers. */
export interface MachineMetadata {
  model?: string;
  osName?: string;
  osVersion?: string;
  architecture?: string;
  cpu?: string;
  memoryBytes?: number;
  gpus?: string[];
}

export interface MachineMetadataSources {
  platform: string;
  architecture: string;
  cpu?: string;
  memoryBytes: number;
  read: (path: string, signal: AbortSignal) => Promise<string>;
  run: (
    command: string,
    args: string[],
    signal: AbortSignal,
  ) => Promise<string>;
}

// All probes share this deadline, including a missing/hung platform utility.
const COLLECTION_TIMEOUT_MS = 2_000;
let machineMetadata: Promise<MachineMetadata> | undefined;

/** Cached for this process, including retries and reconnect registrations. */
export function getMachineMetadata(): Promise<MachineMetadata> {
  machineMetadata ??= collectMachineMetadata().catch(() => ({
    architecture: process.arch,
  }));
  return machineMetadata;
}

function localSources(): MachineMetadataSources {
  const limit = process.constrainedMemory?.();
  return {
    platform: process.platform,
    architecture: process.arch,
    cpu: cpus()[0]?.model,
    memoryBytes: Math.min(totalmem(), limit || Number.POSITIVE_INFINITY),
    read: (path, signal) => readFile(path, { encoding: "utf8", signal }),
    run: (command, args, signal) =>
      new Promise((resolve, reject) => {
        execFile(
          command,
          args,
          {
            encoding: "utf8",
            signal,
            killSignal: "SIGKILL",
            windowsHide: true,
            maxBuffer: 512 * 1024,
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      }),
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.trim().slice(0, 256) || undefined
    : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === "object",
      )
    : [];
}

function gpuNames(values: unknown[]): string[] | undefined {
  // Preserve duplicates: two identical names can represent two physical GPUs.
  const names = values
    .map(text)
    .filter((name): name is string => !!name)
    .slice(0, 16);
  return names.length ? names : undefined;
}

function parseMac(output: string): Partial<MachineMetadata> {
  const data = JSON.parse(output);
  const hardware = records(data?.SPHardwareDataType)[0];
  const software = records(data?.SPSoftwareDataType)[0];
  return {
    model: text(hardware?.machine_name),
    cpu: text(hardware?.chip_type) ?? text(hardware?.cpu_type),
    osVersion: text(software?.os_version)?.match(
      /(?:macOS|OS X)\s+([\d.]+)/,
    )?.[1],
    gpus: gpuNames(
      records(data?.SPDisplaysDataType).map((gpu) => gpu.sppci_model),
    ),
  };
}

function parseWindows(output: string): Partial<MachineMetadata> {
  const data = JSON.parse(output.replace(/^\uFEFF/, ""));
  return {
    model: text(data?.model),
    osName: text(data?.osName),
    osVersion: text(data?.osVersion),
    cpu: text(data?.cpu),
    gpus: gpuNames(Array.isArray(data?.gpus) ? data.gpus : [data?.gpus]),
  };
}

const WINDOWS_QUERY = [
  "$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
  "$computer=Get-CimInstance Win32_ComputerSystem",
  "$os=Get-CimInstance Win32_OperatingSystem",
  "$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1",
  "$gpus=@(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object {$_.Name})",
  "@{model=$computer.Model;osName=$os.Caption;osVersion=$os.Version;cpu=$cpu.Name;gpus=$gpus} | ConvertTo-Json -Compress",
].join("; ");

/** Best effort: unavailable fields are omitted and connection startup is bounded. */
export async function collectMachineMetadata(
  sources: MachineMetadataSources = localSources(),
  timeoutMs = COLLECTION_TIMEOUT_MS,
): Promise<MachineMetadata> {
  const result: MachineMetadata = {
    architecture: sources.architecture,
    cpu: text(sources.cpu),
    memoryBytes: sources.memoryBytes > 0 ? sources.memoryBytes : undefined,
    osName: { darwin: "macOS", win32: "Windows", linux: "Linux" }[
      sources.platform
    ],
  };
  const controller = new AbortController();
  const read = (path: string) =>
    sources.read(path, controller.signal).catch(() => undefined);
  const run = (command: string, args: string[]) =>
    sources.run(command, args, controller.signal).catch(() => "");
  const assign = (fields: Partial<MachineMetadata>) => {
    if (controller.signal.aborted) return;
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) Object.assign(result, { [key]: value });
    }
  };
  const probe = async () => {
    if (sources.platform === "darwin") {
      assign(
        parseMac(
          await run("/usr/sbin/system_profiler", [
            "-json",
            "-detailLevel",
            "mini",
            "SPHardwareDataType",
            "SPSoftwareDataType",
            "SPDisplaysDataType",
          ]),
        ),
      );
    } else if (sources.platform === "win32") {
      assign(
        parseWindows(
          await run("powershell.exe", [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            WINDOWS_QUERY,
          ]),
        ),
      );
    } else if (sources.platform === "linux") {
      const [os, docker, podman, cgroup, model, memoryMax, memoryLimit] =
        await Promise.all([
          read("/etc/os-release"),
          read("/.dockerenv"),
          read("/run/.containerenv"),
          read("/proc/1/cgroup"),
          read("/sys/class/dmi/id/product_name"),
          read("/sys/fs/cgroup/memory.max"),
          read("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
        ]);
      const container =
        docker !== undefined ||
        podman !== undefined ||
        /docker|kubepods|containerd|lxc|libpod/.test(cgroup ?? "");
      const osField = (name: string) => {
        const value = os?.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
        return text(value?.replace(/^(["'])(.*)\1$/, "$2"));
      };
      const memoryBytes = Math.min(
        sources.memoryBytes,
        ...[memoryMax, memoryLimit]
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > 0),
      );
      const modelName = text(model);
      assign({
        model: container
          ? "Container"
          : modelName &&
              !/^(system product name|to be filled by o\.?e\.?m\.?|default string)$/i.test(
                modelName,
              )
            ? modelName
            : undefined,
        osName: osField("NAME"),
        osVersion: osField("VERSION_ID"),
        memoryBytes,
      });
      const nvidia = await run("nvidia-smi", [
        "--query-gpu=name",
        "--format=csv,noheader",
      ]);
      // PCI enumeration can expose host devices to a container. nvidia-smi only
      // reports GPUs accessible through its installed NVIDIA driver.
      const pci = container ? "" : await run("lspci", []);
      const pciGpus = pci.split("\n").flatMap((line) => {
        const name = line.match(
          /(?:VGA compatible controller|3D controller|Display controller):\s*(.+)/i,
        )?.[1];
        return name ? [name] : [];
      });
      assign({ gpus: gpuNames(pciGpus.length ? pciGpus : nvidia.split("\n")) });
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return result;
}
