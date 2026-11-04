import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { api } from "./client";
import type { AgreementContext } from "./types";
import { addMessage, emptyWorkspace, SAMPLE_MESSAGE } from "./workspace";
const context: AgreementContext = {
  interfaceVersion: 1,
  spec: {
    schemaVersion: 1,
    projectId: "p",
    specVersion: 2,
    name: "Website",
    clientWallet: "client",
    developerWallet: "provider",
    milestones: [{ id: 1, title: "Delivery", amountWei: "1" }],
    totalAmountWei: "1",
    approvalRole: "client",
    refundPolicy: "none",
    deadline: null,
  },
  confirmation: {
    projectId: "p",
    specVersion: 2,
    confirmationId: "confirmed-by-server",
    confirmedAt: "2026-11-04T00:00:00Z",
  },
  latestRunId: null,
  generationEnabled: true,
  generatedDeploymentEnabled: false,
};
beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());
function fakeFetch() {
  const fetcher = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ id: "run-1", status: "running" }) });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("crypto", {
    randomUUID: vi.fn().mockReturnValueOnce("first-key").mockReturnValueOnce("next-key"),
  });
  return fetcher;
}
describe("generation HTTP boundary", () => {
  it("reuses request keys after a network error and only rotates on explicit retry", async () => {
    const fetcher = fakeFetch();
    fetcher.mockRejectedValueOnce(new Error("offline"));
    await expect(api.startGeneration("p", context)).rejects.toThrow("offline");
    await api.startGeneration("p", context);
    await api.startGeneration("p", context, "run-1");
    const bodies = fetcher.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(bodies[0]).toEqual({
      specVersion: 2,
      confirmationId: "confirmed-by-server",
      idempotencyKey: "first-key",
    });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2].idempotencyKey).toBe("next-key");
    await api.startGeneration("p", context, "run-1");
    expect(JSON.parse(fetcher.mock.calls[3]![1].body)).toEqual(bodies[2]);
  });
  it("requires server confirmation and never submits browser source/config/report", async () => {
    const fetcher = fakeFetch();
    await expect(api.startGeneration("p", { ...context, confirmation: null })).rejects.toThrow(
      "Confirm",
    );
    expect(fetcher).not.toHaveBeenCalled();
    await api.confirmAgreement("p", 2);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ specVersion: 2, approved: true });
  });
  it("saves a revision with PUT and strips non-payment text from the wire payload", async () => {
    const fetcher = fakeFetch();
    const draft = {
      name: "Site",
      clientWallet: "client",
      developerWallet: "provider",
      milestones: [{ title: "Done", amountWei: "1", paid: true }],
      notes: "Confidential",
    };
    await api.updateTerms("p", 2, draft);
    expect(fetcher.mock.calls[0]![1].method).toBe("PUT");
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
      expectedSpecVersion: 2,
      draft: {
        name: "Site",
        clientWallet: "client",
        developerWallet: "provider",
        milestones: [{ title: "Done", amountWei: "1" }],
      },
    });
  });
  it("polls using GET and exposes backend errors without mock fallback", async () => {
    const fetcher = fakeFetch();
    await api.getGeneration("p", "run-1");
    expect(fetcher.mock.calls[0]![1].method).toBe("GET");
    fetcher.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Agreement changed" }),
    });
    await expect(api.getAgreement("p")).rejects.toThrow("Agreement changed");
  });
});
describe("conversation preservation", () => {
  it("keeps arbitrary supplements without inventing payment rules", () => {
    let state = addMessage(emptyWorkspace(), SAMPLE_MESSAGE);
    const payment = structuredClone(state.draft);
    state = addMessage(state, "Also hand over source code and fix bugs for a month.");
    state = addMessage(state, "I need an automatic refund after a missed deadline.");
    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(3);
    expect(state.draft).toEqual(payment);
    expect(state.messages.at(-1)!.content).toContain("cannot implement refunds");
    api.saveWorkspace(state);
    expect(api.getWorkspace()).toEqual(state);
    api.saveContext("p", state, 2);
    api.clearWorkspace();
    expect(api.getContext("p")!.messages).toEqual(state.messages);
  });
  it("unknown input remains text and never silently uses the example amounts", () => {
    const state = addMessage(emptyWorkspace(), "Build a store for 4 ETH with refunds.");
    expect(state.draft.milestones).toEqual([{ title: "", amountWei: "0" }]);
    expect(state.messages[0]!.content).toBe("Build a store for 4 ETH with refunds.");
  });
});
