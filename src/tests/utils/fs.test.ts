import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFile, readJsonFile, writeJsonFile } from "../../utils/fs";

function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fs-utils-"));
  return join(dir, name);
}

test("writeJsonFile writes formatted JSON with newline", async () => {
  const path = tempFile("data.json");
  const payload = { foo: "bar", nested: { count: 1 } };
  await writeJsonFile(path, payload);
  const contents = await readFile(path);
  expect(contents).toBe('{
  "foo": "bar",
  "nested": {
    "count": 1
  }
}\n');
  const parsed = await readJsonFile<typeof payload>(path);
  expect(parsed).toEqual(payload);
});

test("writeJsonFile respects custom indentation", async () => {
  const path = tempFile("custom.json");
  await writeJsonFile(path, { value: [1, 2] }, { indent: 0 });
  const contents = await readFile(path);
  expect(contents).toBe('{"value":[1,2]}\n');
});