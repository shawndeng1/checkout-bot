import { it, expect } from "vitest";
import { acceptSnapshot, useWorkspace } from "../apps/desktop/src/store";
import { Store } from "../packages/database/src/index";
it("rejects older and equal snapshots", async () => {
  const store = await Store.open(":memory:");
  try {
    const initial = store.snapshot(),
      newer = { ...initial, revision: 10 };
    expect(acceptSnapshot(initial, newer)).toBe(newer);
    expect(acceptSnapshot(newer, { ...initial, revision: 9 })).toBe(newer);
    expect(acceptSnapshot(newer, { ...initial, revision: 10 })).toBe(newer);
  } finally {
    store.close();
  }
});
it("a delayed command response cannot replace a newer subscription update", async () => {
  const store = await Store.open(":memory:");
  const previous = (globalThis as any).window;
  try {
    const initial = store.snapshot();
    let resolve!: (data: typeof initial) => void;
    (globalThis as any).window = {
      retail: {
        command: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
    };
    useWorkspace.setState({ data: initial });
    const command = useWorkspace
      .getState()
      .command({ type: "saveGroup", data: { name: "slow", retailer: "mock" } });
    const newest = {
      ...initial,
      revision: 20,
      groups: [{ id: "newest", name: "newest", retailer: "mock" }],
    };
    useWorkspace.getState().setData(newest);
    resolve({ ...initial, revision: 19 });
    await command;
    expect(useWorkspace.getState().data).toBe(newest);
  } finally {
    (globalThis as any).window = previous;
    useWorkspace.setState({ data: null });
    store.close();
  }
});
