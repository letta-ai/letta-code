import { describe, expect, it } from "bun:test";
import {
  collectMachineMetadata,
  getMachineMetadata,
  type MachineMetadataSources,
} from "./machine-metadata";

function sources(
  platform: string,
  files: Record<string, string> = {},
  commands: Record<string, string> = {},
): MachineMetadataSources {
  return {
    platform,
    architecture: "arm64",
    cpu: "Test CPU",
    memoryBytes: 16 * 1024 ** 3,
    read: async (path) => {
      const value = files[path];
      if (value === undefined) throw new Error("ENOENT");
      return value;
    },
    run: async (command) => {
      const value = commands[command];
      if (value === undefined) throw new Error("command missing");
      return value;
    },
  };
}

describe("machine metadata", () => {
  it("extracts a Mac's human model, OS, chip and GPU without identifiers", async () => {
    const machine = await collectMachineMetadata(
      sources(
        "darwin",
        {},
        {
          "/usr/sbin/system_profiler": JSON.stringify({
            SPHardwareDataType: [
              {
                machine_name: "Mac mini",
                chip_type: "Apple M4 Pro",
                serial_number: "private-serial",
                platform_UUID: "private-uuid",
              },
            ],
            SPSoftwareDataType: [
              { os_version: "macOS 26.0 (25A354)", user_name: "Private User" },
            ],
            SPDisplaysDataType: [{ sppci_model: "Apple M4 Pro" }],
          }),
        },
      ),
    );
    expect(machine).toEqual({
      model: "Mac mini",
      osName: "macOS",
      osVersion: "26.0",
      architecture: "arm64",
      cpu: "Apple M4 Pro",
      memoryBytes: 16 * 1024 ** 3,
      gpus: ["Apple M4 Pro"],
    });
    expect(JSON.stringify(machine)).not.toContain("private");
  });

  it("reads Windows 11 and multiple GPUs from selected CIM fields", async () => {
    const machine = await collectMachineMetadata(
      sources(
        "win32",
        {},
        {
          "powershell.exe": JSON.stringify({
            model: "Precision 3660",
            osName: "Microsoft Windows 11 Pro",
            osVersion: "10.0.22631",
            cpu: "Intel Core i9",
            gpus: ["NVIDIA GeForce RTX 4090", "Intel UHD Graphics 770"],
          }),
        },
      ),
    );
    expect(machine).toMatchObject({
      model: "Precision 3660",
      osName: "Microsoft Windows 11 Pro",
      osVersion: "10.0.22631",
      cpu: "Intel Core i9",
      gpus: ["NVIDIA GeForce RTX 4090", "Intel UHD Graphics 770"],
    });
  });

  it("reads Linux distro, DMI model and PCI display controllers", async () => {
    const machine = await collectMachineMetadata(
      sources(
        "linux",
        {
          "/etc/os-release":
            'NAME="Ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"',
          "/sys/class/dmi/id/product_name": "ThinkPad P16 Gen 2\n",
        },
        {
          lspci:
            "00:02.0 VGA compatible controller: Intel Corporation Graphics\n01:00.0 3D controller: NVIDIA Corporation AD102 [GeForce RTX 4090]\n00:14.0 USB controller: Intel USB",
        },
      ),
    );
    expect(machine).toMatchObject({
      model: "ThinkPad P16 Gen 2",
      osName: "Ubuntu",
      osVersion: "24.04",
      gpus: [
        "Intel Corporation Graphics",
        "NVIDIA Corporation AD102 [GeForce RTX 4090]",
      ],
    });
  });

  it("omits generic Windows model placeholders so the UI can use the OS", async () => {
    for (const model of [
      "System Product Name",
      "To Be Filled By O.E.M.",
      "Default string",
    ]) {
      const machine = await collectMachineMetadata(
        sources(
          "win32",
          {},
          {
            "powershell.exe": JSON.stringify({
              model,
              osName: "Microsoft Windows 11 Pro",
            }),
          },
        ),
      );
      expect(machine.model).toBeUndefined();
      expect(machine.osName).toBe("Microsoft Windows 11 Pro");
    }
  });

  it("does not advertise host DMI or PCI devices inside a container", async () => {
    const input = sources(
      "linux",
      {
        "/.dockerenv": "",
        "/sys/class/dmi/id/product_name": "Host workstation",
        "/sys/fs/cgroup/memory.max": String(4 * 1024 ** 3),
      },
      {
        "nvidia-smi": "NVIDIA GeForce RTX 4090\nNVIDIA GeForce RTX 4090\n",
        lspci: "00:02.0 VGA compatible controller: Host GPU",
      },
    );
    expect(await collectMachineMetadata(input)).toMatchObject({
      model: "Container",
      memoryBytes: 4 * 1024 ** 3,
      gpus: ["NVIDIA GeForce RTX 4090", "NVIDIA GeForce RTX 4090"],
    });
  });

  it("recognizes cgroup container paths without a marker file", async () => {
    const machine = await collectMachineMetadata(
      sources("linux", {
        "/proc/1/cgroup": "0::/kubepods/burstable/pod123/abc",
        "/sys/class/dmi/id/product_name": "Physical host",
      }),
    );
    expect(machine.model).toBe("Container");
  });

  it("retains basic specs when probes fail or return malformed JSON", async () => {
    for (const input of [
      sources("darwin", {}, { "/usr/sbin/system_profiler": "not JSON" }),
      sources("win32"),
      sources("linux"),
    ]) {
      expect(await collectMachineMetadata(input)).toMatchObject({
        architecture: "arm64",
        cpu: "Test CPU",
        memoryBytes: 16 * 1024 ** 3,
      });
    }
  });

  it("returns partial specs and aborts probes at the shared deadline", async () => {
    let signal: AbortSignal | undefined;
    const input = sources("darwin");
    input.run = async (_command, _args, receivedSignal) => {
      signal = receivedSignal;
      return new Promise(() => {});
    };
    const machine = await collectMachineMetadata(input, 10);
    expect(signal?.aborted).toBe(true);
    expect(machine.cpu).toBe("Test CPU");
    expect(machine.model).toBeUndefined();
  });

  it("reuses one collection promise across registrations", async () => {
    expect(getMachineMetadata()).toBe(getMachineMetadata());
    expect((await getMachineMetadata()).architecture).toBe(process.arch);
  });

  it("smokes native probes on the current CI machine within a bounded time", async () => {
    // No fixture sources: this invokes system_profiler, PowerShell CIM, or the
    // Linux probes on the matching CI runner. Hardware remains best effort.
    const machine = await collectMachineMetadata();
    expect(machine.architecture).toBe(process.arch);
    expect(machine.osName).toBeString();
    expect(machine.osName?.length).toBeGreaterThan(0);
    if (process.platform === "darwin") expect(machine.osName).toBe("macOS");
    if (process.platform === "win32") expect(machine.osName).toMatch(/Windows/);
  }, 5_000);
});
