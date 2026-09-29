import { expect, test } from "bun:test";
import { LocalStore } from "./local-store";

test("local conversation updates add tags without replacing existing tags", () => {
  const store = new LocalStore("agent-tags");
  const conversation = store.createConversation({ agent_id: "agent-tags" });
  store.updateConversation(conversation.id, { tags: ["existing"] });
  store.updateConversation(conversation.id, { tags_to_add: ["one", "one"] });
  expect(
    store.updateConversation(conversation.id, { tags_to_add: ["two"] }),
  ).toMatchObject({ tags: ["existing", "one", "two"] });
  expect(
    store.updateConversation(conversation.id, {
      tags: ["replacement"],
      tags_to_add: ["new"],
    }),
  ).toMatchObject({ tags: ["replacement", "new"] });
  expect(store.updateConversation(conversation.id, { tags: [] })).toMatchObject(
    { tags: [] },
  );
});
