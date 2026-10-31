import { describe, expect, it, vi } from "vitest";
import { readCostRows } from "./cost-rows";
describe("cost row pagination", () => {
  it("rejects a failed later page instead of returning incomplete totals", async () => {
    const fetch = vi.fn(async (from: number) => from === 0
      ? { data: Array.from({ length: 1000 }, (_, id) => ({ id })), error: null }
      : { data: null, error: new Error("read failed") });
    await expect(readCostRows(fetch)).rejects.toThrow("read failed");
    expect(fetch).toHaveBeenLastCalledWith(1000, 1999);
  });
});
