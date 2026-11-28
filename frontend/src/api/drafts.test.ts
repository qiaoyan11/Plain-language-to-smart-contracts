import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import type { DraftContext, DraftSession } from "./types";

const context: DraftContext = {
  clarificationEnabled: false,
  mode: "local-chain",
  clientWallet: "0x1111111111111111111111111111111111111111",
  developerWallet: "0x2222222222222222222222222222222222222222",
};
const session: DraftSession = {
  id: "draft/one ?",
  revision: 3,
  createdAt: "2026-11-26T00:00:00Z",
  updatedAt: "2026-11-26T00:01:00Z",
  messages: [{ role: "user", content: "Pay 30% after accepting the homepage." }],
  result: {
    status: "needsClarification",
    draftSpec: {
      schemaVersion: 1,
      projectId: "draft/one ?",
      specVersion: 3,
      name: "Website",
      clientWallet: context.clientWallet,
      developerWallet: context.developerWallet,
      milestones: [{ id: 1, title: "Homepage", amountWei: null }],
      totalAmountWei: null,
      approvalRole: "client",
      refundPolicy: "none",
      deadline: null,
    },
    questions: [{ field: "totalAmountWei", question: "What is the total price?" }],
    unsupportedTerms: [],
    separateTerms: ["Both parties keep a separate confidentiality agreement."],
  },
  busy: false,
  pendingMessage: {
    content: "Change the total price to 0.012 ETH.",
    requestKey: "pending-message-key",
    expectedRevision: 3,
  },
  lastError: "The assistant could not finish. Retry this message.",
  confirmedProjectId: null,
};

function mockFetch(value: unknown = session) {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => value });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("server-owned drafting API", () => {
  it("reads the server mode and creates only an empty server draft", async () => {
    const fetcher = mockFetch(context);
    await expect(api.getDraftContext()).resolves.toEqual(context);
    expect(fetcher.mock.calls[0]).toEqual([
      "/api/drafts/context",
      { method: "GET", headers: { "Content-Type": "application/json" } },
    ]);
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => session });
    await expect(api.createDraft()).resolves.toEqual(session);
    expect(fetcher.mock.calls[1]).toEqual([
      "/api/drafts",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    ]);
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it("restores the exact server session with GET, including failed pending messages and separate terms", async () => {
    const fetcher = mockFetch();
    api.setActiveDraftId(session.id);
    await expect(api.getDraft(api.getActiveDraftId()!)).resolves.toEqual(session);
    await expect(api.getDraft(session.id)).resolves.toEqual(session);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toBe(`/api/drafts/${encodeURIComponent(session.id)}`);
      expect(options.method).toBe("GET");
      expect(options).not.toHaveProperty("body");
    }
    // Restoring a draft must not persist its conversation, result or retry token in browser storage.
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(session.id);
    expect(localStorage.length).toBe(0);
  });

  it("sends exact user text, revision and caller-owned request key, including a retry after a lost response", async () => {
    const fetcher = mockFetch();
    const message =
      "  Accept the homepage against the agreed design.\nThe second milestone amount is still open.  ";
    const key = "unchanged-request-key";
    fetcher.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(api.sendDraftMessage(session.id, message, 3, key)).rejects.toThrow(
      "Connection lost",
    );
    await expect(api.sendDraftMessage(session.id, message, 3, key)).resolves.toEqual(session);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toBe(`/api/drafts/${encodeURIComponent(session.id)}/messages`);
      expect(options.method).toBe("POST");
      expect(JSON.parse(options.body)).toEqual({ message, expectedRevision: 3, requestKey: key });
    }
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it("confirms only the chosen server revision, without sending browser payment rules or model output", async () => {
    const confirmed = {
      project: { id: "server-project" },
      agreement: { confirmation: { confirmationId: "server-confirmation" } },
    };
    const fetcher = mockFetch(confirmed);
    await expect(api.confirmDraft(session.id, 3)).resolves.toEqual(confirmed);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe(`/api/drafts/${encodeURIComponent(session.id)}/confirmation`);
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ approved: true, expectedRevision: 3 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["create", () => api.createDraft(), "Agreement assistant is disabled"],
    [
      "restore",
      () => api.getDraft(session.id),
      "Draft not found.",
    ],
    [
      "send",
      () => api.sendDraftMessage(session.id, "New message", 3, "request-key-001"),
      "Draft changed. Reload it before continuing.",
    ],
    [
      "confirm",
      () => api.confirmDraft(session.id, 3),
      "Resolve the last message before confirming the agreement",
    ],
  ] as const)(
    "surfaces the backend %s error without creating a simulated success",
    async (_name, invoke, error) => {
      const fetcher = mockFetch();
      fetcher.mockResolvedValueOnce({ ok: false, json: async () => ({ error }) });
      api.setActiveDraftId(session.id);
      await expect(invoke()).rejects.toThrow(error);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(api.getActiveDraftId()).toBe(session.id);
      expect(sessionStorage.length).toBe(1);
      expect(localStorage.length).toBe(0);
    },
  );

  it("does not turn an unreadable backend response into an empty or ready draft", async () => {
    const fetcher = mockFetch();
    fetcher.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError("Truncated response");
      },
    });
    await expect(api.getDraft(session.id)).rejects.toThrow("Truncated response");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sessionStorage.length).toBe(0);
  });

  it("stores only the active draft ID and clears it without deleting reference-demo data", () => {
    const fetcher = mockFetch();
    sessionStorage.setItem("reference-demo-data", "keep this");
    expect(api.getActiveDraftId()).toBeNull();
    api.setActiveDraftId("first-draft");
    expect(api.getActiveDraftId()).toBe("first-draft");
    api.setActiveDraftId(session.id);
    expect(api.getActiveDraftId()).toBe(session.id);
    expect(sessionStorage.length).toBe(2);
    api.setActiveDraftId(null);
    expect(api.getActiveDraftId()).toBeNull();
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem("reference-demo-data")).toBe("keep this");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
