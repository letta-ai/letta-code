import { describe, expect, test } from "bun:test";
import { BoundedRegistry } from "@/cli/helpers/paste-registry";

// BoundedRegistry backs the module-level paste/image registries. These tests
// exercise eviction with tiny budgets so the leak backstop is verified without
// allocating the production budgets (16 MB text / 32 MB image).

describe("BoundedRegistry", () => {
  test("keeps entries while under the byte budget", () => {
    const reg = new BoundedRegistry<string>(100, (s) => s.length);
    reg.set(1, "aaaa");
    reg.set(2, "bbbb");
    expect(reg.get(1)).toBe("aaaa");
    expect(reg.get(2)).toBe("bbbb");
    expect(reg.size).toBe(2);
  });

  test("evicts oldest entries first when over budget", () => {
    const reg = new BoundedRegistry<string>(10, (s) => s.length);
    reg.set(1, "aaaa"); // 4 bytes
    reg.set(2, "bbbb"); // 8 bytes
    reg.set(3, "cccc"); // 12 bytes -> evicts id 1 (8 bytes), then fits
    expect(reg.has(1)).toBe(false);
    expect(reg.get(2)).toBe("bbbb");
    expect(reg.get(3)).toBe("cccc");
  });

  test("evicts as many old entries as needed to fit", () => {
    const reg = new BoundedRegistry<string>(5, (s) => s.length);
    reg.set(1, "aaaa");
    reg.set(2, "bbbb");
    reg.set(3, "ccccc"); // 13 -> 9 -> 5 bytes
    expect(reg.has(1)).toBe(false);
    expect(reg.has(2)).toBe(false);
    expect(reg.get(3)).toBe("ccccc");
    expect(reg.size).toBe(1);
  });

  test("always keeps the entry just inserted, even if it alone exceeds the budget", () => {
    const reg = new BoundedRegistry<string>(4, (s) => s.length);
    reg.set(1, "aaaa");
    reg.set(2, "0123456789"); // 10 bytes, over budget by itself
    expect(reg.has(1)).toBe(false);
    expect(reg.get(2)).toBe("0123456789");
    expect(reg.size).toBe(1);
  });

  test("delete returns bytes to the budget", () => {
    const reg = new BoundedRegistry<string>(10, (s) => s.length);
    reg.set(1, "aaaa"); // 4
    reg.set(2, "bbbb"); // 8
    reg.delete(1); // 4
    reg.set(3, "cccccc"); // 10, no eviction needed
    expect(reg.get(2)).toBe("bbbb");
    expect(reg.get(3)).toBe("cccccc");
    expect(reg.size).toBe(2);
  });

  test("re-setting an id replaces its bytes instead of double-counting", () => {
    const reg = new BoundedRegistry<string>(10, (s) => s.length);
    reg.set(1, "aaaa"); // 4
    reg.set(1, "bbbbbb"); // 6, not 10
    reg.set(2, "cccc"); // 10 total, no eviction
    expect(reg.get(1)).toBe("bbbbbb");
    expect(reg.get(2)).toBe("cccc");
    expect(reg.size).toBe(2);
  });

  test("delete of a missing id is a no-op", () => {
    const reg = new BoundedRegistry<string>(10, (s) => s.length);
    reg.set(1, "aaaa");
    reg.delete(999);
    expect(reg.get(1)).toBe("aaaa");
    expect(reg.size).toBe(1);
  });
});
