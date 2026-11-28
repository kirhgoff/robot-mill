import { expect, test } from "bun:test";
import { openStore } from "./store";

test("insert, get, update and list round trip", () => {
  const store = openStore(":memory:");
  const first = store.insertTask({ kind: "build", title: "One", description: "d", pinned_type: "codex" });
  const second = store.insertTask({ kind: "review", title: "Two", parent: first.id });
  expect([first.id, second.id]).toEqual(["t1", "t2"]);
  expect(first).toMatchObject({ state: "queued", pinned_type: "codex", description: "d", session: null });

  const updated = store.updateTask(first.id, { state: "running", session: "mill-t1" });
  expect(updated).toMatchObject({ state: "running", session: "mill-t1" });
  expect(store.getTask("t1")).toEqual(updated);
  expect(store.getTask("missing")).toBeNull();
  expect(store.listTasks().map((task) => task.id)).toEqual(["t1", "t2"]);
  expect(store.listTasks("queued").map((task) => task.id)).toEqual(["t2"]);
});
