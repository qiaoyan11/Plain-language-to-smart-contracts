import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";

afterEach(() => vi.unstubAllGlobals());
describe("known payment requests", () => {
  it("sends only the operation and stage, never a browser amount or recipient", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ planId: "stored-plan" }) });
    vi.stubGlobal("fetch", fetcher);
    await api.planKnownOperation("p/1", { action: "deposit" });
    const payment = { action: "acceptMilestone" as const, milestoneId: 1, amountWei: "1", to: "another-wallet" };
    await api.planKnownOperation("p/1", payment);
    await api.confirmOperation("p/1", "plan/1");
    expect(fetcher.mock.calls[0]![0]).toBe("/api/projects/p%2F1/action-plans");
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ action: "deposit" });
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ action: "acceptMilestone", milestoneId: 1 });
    expect(fetcher.mock.calls[2]![0]).toBe("/api/projects/p%2F1/plans/plan%2F1/confirmation");
    expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({ approved: true });
    expect(fetcher.mock.calls.every(([, options]) => options.method === "POST")).toBe(true);
  });
  it("reports changed chain state without calling a model or silently retrying", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "This milestone is already paid" }) });
    vi.stubGlobal("fetch", fetcher);
    await expect(api.planKnownOperation("p", { action: "acceptMilestone", milestoneId: 1 })).rejects.toThrow("already paid");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
