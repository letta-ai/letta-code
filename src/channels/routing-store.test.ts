import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "./config";
import {
  addRoute,
  clearAllRoutes,
  getAllRoutes,
  getRoute,
  loadRoutes,
  readRoutes,
} from "./routing";
import { writeChannelRoutesToDisk } from "./routing-store";
import { getLocalChannelTeleportError } from "./teleport-guard";
import type { ChannelRoute } from "./types";

const route: ChannelRoute = {
  chatId: "1001",
  agentId: "agent-review",
  conversationId: "conv-review",
  enabled: true,
  createdAt: "2026-09-15T00:00:00.000Z",
};
const legacyText = `${JSON.stringify({ routes: [route] })}\n`;

function ioError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("routing persistence", () => {
  let root: string;
  let dir: string;
  let current: string;
  let legacy: string;

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "letta-routing-store-"));
    dir = join(root, "telegram");
    fs.mkdirSync(dir);
    current = join(dir, "routing.json");
    legacy = join(dir, "routing.yaml");
    __testOverrideChannelsRoot(root);
    clearAllRoutes();
  });

  afterEach(() => {
    mock.restore();
    clearAllRoutes();
    __testOverrideChannelsRoot(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("adding the first route creates only routing.json", () => {
    fs.rmdirSync(dir);
    addRoute("telegram", route);
    expect(fs.readdirSync(dir)).toEqual(["routing.json"]);
    expect(readRoutes("telegram")).toEqual([expect.objectContaining(route)]);
  });

  test.each(["readRoutes", "loadRoutes"])(
    "%s migrates legacy routes and can reread the current file",
    (reader) => {
      fs.writeFileSync(legacy, legacyText);
      if (reader === "loadRoutes") {
        loadRoutes("telegram");
        expect(getRoute("telegram", route.chatId)).toMatchObject(route);
      }
      expect(readRoutes("telegram")).toEqual([route]);
      if (reader === "readRoutes") expect(getAllRoutes()).toEqual([]);
      expect(fs.readFileSync(current, "utf8")).toBe(legacyText);
      expect(fs.existsSync(legacy)).toBe(false);
      expect(readRoutes("telegram")).toEqual([route]);
    },
  );

  test("teleport is blocked before any cache load on an upgraded install", () => {
    fs.writeFileSync(legacy, legacyText);
    expect(getLocalChannelTeleportError(route)).toContain(
      "Teleport is blocked",
    );
    expect(getAllRoutes()).toEqual([]);
  });

  test.each(["EACCES", "EROFS", "EPERM", "ENOTSUP"])(
    "migration failure %s preserves readable routes and can be retried",
    (code) => {
      fs.writeFileSync(legacy, legacyText);
      const link = spyOn(fs, "linkSync").mockImplementation(() => {
        throw ioError(code);
      });
      expect(readRoutes("telegram")).toEqual([route]);
      loadRoutes("telegram");
      expect(getRoute("telegram", route.chatId)?.conversationId).toBe(
        route.conversationId,
      );
      expect(getLocalChannelTeleportError(route)).toContain(
        "Teleport is blocked",
      );
      expect(fs.readFileSync(legacy, "utf8")).toBe(legacyText);
      expect(fs.existsSync(current)).toBe(false);
      link.mockRestore();
      expect(readRoutes("telegram")).toEqual([route]);
      expect(fs.existsSync(legacy)).toBe(false);
    },
  );

  test("current routes win when both files exist, including an empty current table", () => {
    fs.writeFileSync(legacy, legacyText);
    fs.writeFileSync(current, '{"routes":[]}');
    expect(readRoutes("telegram")).toEqual([]);
    expect(fs.readFileSync(legacy, "utf8")).toBe(legacyText);
    expect(fs.readFileSync(current, "utf8")).toBe('{"routes":[]}');
  });

  test.each(["{ broken", "null", "{}", '{"routes":{}}'])(
    "invalid legacy content is preserved: %s",
    (text) => {
      fs.writeFileSync(legacy, text);
      expect(readRoutes("telegram")).toEqual([]);
      loadRoutes("telegram");
      expect(getRoute("telegram", route.chatId)).toBeNull();
      expect(fs.readFileSync(legacy, "utf8")).toBe(text);
      expect(fs.existsSync(current)).toBe(false);
    },
  );

  test("invalid current content never revives stale legacy routes", () => {
    fs.writeFileSync(legacy, legacyText);
    fs.writeFileSync(current, "{ broken");
    expect(readRoutes("telegram")).toEqual([]);
    expect(fs.readFileSync(current, "utf8")).toBe("{ broken");
    expect(fs.readFileSync(legacy, "utf8")).toBe(legacyText);
  });

  test("a concurrent save wins without being overwritten by migration", () => {
    fs.writeFileSync(legacy, legacyText);
    const linkSync = fs.linkSync;
    spyOn(fs, "linkSync").mockImplementation((source, target) => {
      writeChannelRoutesToDisk("telegram", []);
      return linkSync(source, target);
    });
    expect(readRoutes("telegram")).toEqual([]);
    expect(JSON.parse(fs.readFileSync(current, "utf8"))).toEqual({
      routes: [],
    });
    expect(fs.readFileSync(legacy, "utf8")).toBe(legacyText);
  });

  test("a concurrent migration between the two reads is observed", () => {
    fs.writeFileSync(legacy, legacyText);
    const readFileSync = fs.readFileSync;
    spyOn(fs, "readFileSync").mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      if (args[0] === legacy) {
        fs.linkSync(legacy, current);
        fs.unlinkSync(legacy);
      }
      return readFileSync(...args);
    }) as typeof fs.readFileSync);
    expect(readRoutes("telegram")).toEqual([route]);
  });

  test("saving after interrupted migration does not modify the legacy backup", () => {
    fs.writeFileSync(legacy, legacyText);
    fs.linkSync(legacy, current);
    writeChannelRoutesToDisk("telegram", []);
    expect(readRoutes("telegram")).toEqual([]);
    expect(fs.readFileSync(legacy, "utf8")).toBe(legacyText);
  });

  test("failed cleanup leaves a complete authoritative current file", () => {
    fs.writeFileSync(legacy, legacyText);
    spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw ioError("EACCES");
    });
    expect(readRoutes("telegram")).toEqual([route]);
    expect(fs.readFileSync(current, "utf8")).toBe(legacyText);
    expect(fs.readFileSync(legacy, "utf8")).toBe(legacyText);
    expect(readRoutes("telegram")).toEqual([route]);
  });

  test("saves publish a complete snapshot and remove the temporary file", () => {
    fs.writeFileSync(current, '{"routes":[]}');
    const renameSync = fs.renameSync;
    spyOn(fs, "renameSync").mockImplementation((source, target) => {
      expect(JSON.parse(fs.readFileSync(current, "utf8"))).toEqual({
        routes: [],
      });
      expect(JSON.parse(fs.readFileSync(source, "utf8"))).toEqual({
        routes: [route],
      });
      return renameSync(source, target);
    });
    writeChannelRoutesToDisk("telegram", [route]);
    expect(readRoutes("telegram")).toEqual([route]);
    loadRoutes("telegram");
    expect(getRoute("telegram", route.chatId)).toMatchObject(route);
    expect(fs.readdirSync(dir)).toEqual(["routing.json"]);
  });

  test.each(["writeFileSync", "fsyncSync", "renameSync"] as const)(
    "failed %s preserves the previous snapshot",
    (operation) => {
      fs.writeFileSync(current, legacyText);
      spyOn(fs, operation).mockImplementation(() => {
        throw ioError("EIO");
      });
      expect(() => writeChannelRoutesToDisk("telegram", [])).toThrow("EIO");
      expect(fs.readFileSync(current, "utf8")).toBe(legacyText);
      expect(fs.readdirSync(dir)).toEqual(["routing.json"]);
    },
  );

  test("a partial temporary write cannot shadow the legacy file", () => {
    fs.writeFileSync(legacy, legacyText);
    const writeFileSync = fs.writeFileSync;
    spyOn(fs, "writeFileSync").mockImplementation((path) => {
      writeFileSync(path, "{ partial");
      throw ioError("ENOSPC");
    });
    expect(() => writeChannelRoutesToDisk("telegram", [])).toThrow("ENOSPC");
    expect(fs.existsSync(current)).toBe(false);
    expect(fs.readFileSync(legacy, "utf8")).toBe(legacyText);
    expect(fs.readdirSync(dir)).toEqual(["routing.yaml"]);
  });
});
