import { expect, test } from "bun:test";
import { LocalStore } from "./local-store";

test("local agent updates preserve additive tags and replace before appending", () => {
  const store = new LocalStore("agent-default");
  const agent = store.createAgent({ tags: ["existing"] });
  expect(
    store.updateAgent(agent.id, { tags_to_add: ["first", "first"] }).tags,
  ).toEqual(["existing", "first"]);
  expect(store.updateAgent(agent.id, { tags_to_add: ["second"] }).tags).toEqual(
    ["existing", "first", "second"],
  );
  expect(store.updateAgent(agent.id, { tags_to_add: [] }).tags).toEqual([
    "existing",
    "first",
    "second",
  ]);
  expect(
    store.updateAgent(agent.id, {
      tags: ["replacement"],
      tags_to_add: ["addition"],
    }).tags,
  ).toEqual(["replacement", "addition"]);
  expect(store.updateAgent(agent.id, { tags: [] }).tags).toEqual([]);
});
