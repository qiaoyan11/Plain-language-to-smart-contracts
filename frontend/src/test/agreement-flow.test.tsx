import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => navigate,
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
import { CreatePage } from "@/routes/index";
import { ConfirmPage } from "@/routes/confirm";
import { GenerationResultView } from "@/components/GenerationResultView";
import { api, type Project, type AgreementContext } from "@/api/client";
import type { DraftSession, GenerationRun } from "@/api/types";
import { financeBefore, financeAfter } from "./fixtures/finance-conversation";

const context = {
  clarificationEnabled: true,
  mode: "local-chain" as const,
  clientWallet: "0x" + "1".repeat(40),
  developerWallet: "0x" + "2".repeat(40),
};
const empty: DraftSession = {
  id: "draft-1",
  revision: 0,
  createdAt: "",
  updatedAt: "",
  messages: [],
  result: null,
  busy: false,
  confirmedProjectId: null,
  pendingMessage: null,
  lastError: null,
};
const ready: DraftSession = {
  ...empty,
  revision: 1,
  messages: [{ role: "user", content: "Build a website for 1 ETH." }],
  result: {
    status: "readyForConfirmation",
    questions: [],
    unsupportedTerms: [],
    separateTerms: ["We will document maintenance separately."],
    draftSpec: {
      schemaVersion: 1,
      projectId: "draft-1",
      specVersion: 1,
      name: "Website",
      clientWallet: context.clientWallet,
      developerWallet: context.developerWallet,
      totalAmountWei: "1000000000000000000",
      milestones: [{ id: 1, title: "Approved website", amountWei: "1000000000000000000" }],
      approvalRole: "client",
      refundPolicy: "none",
      deadline: null,
    },
  },
};
const project: Project = {
  schemaVersion: 2,
  id: "project-1",
  name: "Website",
  clientWallet: context.clientWallet,
  developerWallet: context.developerWallet,
  createdAt: "",
  contractAddress: null,
  totalAmountWei: "1000000000000000000",
  escrowBalanceWei: "0",
  funded: false,
  milestones: [{ id: 1, title: "Approved website", amountWei: "1000000000000000000", paid: false }],
  transactions: [],
};
const agreement: AgreementContext = {
  interfaceVersion: 1,
  spec: { ...ready.result!.draftSpec, projectId: project.id } as AgreementContext["spec"],
  confirmation: {
    projectId: project.id,
    specVersion: 1,
    confirmationId: "confirmed",
    confirmedAt: "",
  },
  latestRunId: null,
  generationEnabled: true,
  generatedDeploymentEnabled: true,
  draftOrigin: { draftId: ready.id, revision: ready.revision },
};
function openPage(page: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
}
function type(text: string) {
  fireEvent.change(screen.getByLabelText("Describe your agreement or add a detail"), {
    target: { value: text },
  });
}
async function openReady() {
  api.setActiveDraftId(ready.id);
  vi.mocked(api.getDraft).mockResolvedValue(ready);
  return openPage(<ConfirmPage />);
}
beforeEach(() => {
  sessionStorage.clear();
  navigate.mockClear();
  vi.spyOn(api, "getDraftContext").mockResolvedValue(context);
  vi.spyOn(api, "getDraft").mockResolvedValue(empty);
  vi.spyOn(api, "createDraft").mockResolvedValue(empty);
  vi.spyOn(api, "sendDraftMessage").mockResolvedValue(ready);
  vi.spyOn(api, "confirmDraft").mockResolvedValue({ project, agreement });
  vi.spyOn(api, "startGeneration").mockResolvedValue({} as GenerationRun);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("server-owned agreement conversation", () => {
  it("keeps the finance-app payment schedule and moves to wallets after the user repeats the first milestone percentage", async () => {
    api.setActiveDraftId(financeBefore.id);
    vi.mocked(api.getDraft).mockResolvedValue(financeBefore);
    vi.mocked(api.sendDraftMessage).mockResolvedValue(financeAfter);
    const first = openPage(<CreatePage />);
    await screen.findByText("0.08 test ETH");
    const message = financeAfter.messages.at(-1)!.content;
    type(message);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText(message);
    expect(api.sendDraftMessage).toHaveBeenCalledWith(
      financeBefore.id,
      message,
      financeBefore.revision,
      expect.any(String),
    );
    const summary = within(screen.getByLabelText("Current agreement draft"));
    expect(summary.getByText("0.08 test ETH")).toBeTruthy();
    expect(summary.getAllByText("0.02 test ETH")).toHaveLength(4);
    expect(summary.queryByText("Amount needed")).toBeNull();
    for (const milestone of financeAfter.result.draftSpec.milestones)
      expect(summary.getByText(`${milestone.id}. ${milestone.title}`)).toBeTruthy();
    const log = screen.getByRole("log");
    expect(within(log).getAllByText("Agreement assistant")).toHaveLength(5);
    const latest = log.lastElementChild!;
    expect(latest).toHaveTextContent("The draft is unchanged.");
    expect(latest).toHaveTextContent(
      "What wallet address will the client use to fund the contract?",
    );
    expect(latest).not.toHaveTextContent(
      /milestone 1|amount unresolved|Your latest message is recorded/,
    );
    expect(log).toHaveTextContent("4 milestones at 0.02 ETH each, for a total of 0.08 ETH.");
    expect(screen.getByRole("button", { name: "Review agreement" })).toBeDisabled();
    expect(api.confirmDraft).not.toHaveBeenCalled();

    first.unmount();
    vi.mocked(api.getDraft).mockResolvedValue(financeAfter);
    openPage(<CreatePage />);
    await screen.findByText(message);
    expect(within(screen.getByRole("log")).getAllByText("Agreement assistant")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Review agreement" })).toBeDisabled();
    expect(api.sendDraftMessage).toHaveBeenCalledTimes(1);
    expect(api.createDraft).not.toHaveBeenCalled();
  });
  it("pairs saved assistant replies with each user message and restores them without another request", async () => {
    const draft: DraftSession = {
      ...ready,
      revision: 2,
      messages: [
        { role: "user", content: "Build a website." },
        { role: "user", content: "The total is 1 ETH." },
      ],
      turns: [
        {
          revision: 1,
          reply: "Recorded a website milestone.",
          question: { field: "totalAmountWei", question: "What is the total payment?" },
        },
        {
          revision: 2,
          reply: "The total is now 1 ETH.",
          question: { field: "clientWallet", question: "Which wallet will deposit and approve?" },
        },
      ],
      result: {
        ...ready.result!,
        status: "needsClarification",
        questions: [
          { field: "clientWallet", question: "Which wallet will deposit and approve?" },
          { field: "developerWallet", question: "Which wallet will receive payment?" },
        ],
      },
    };
    api.setActiveDraftId(draft.id);
    vi.mocked(api.getDraft).mockResolvedValue(draft);
    const first = openPage(<CreatePage />);
    await screen.findByText("The total is now 1 ETH.");
    const log = screen.getByRole("log");
    const replies = within(log).getAllByText("Agreement assistant");
    expect(replies).toHaveLength(2);
    expect(Array.from(log.children).map((child) => child.textContent)).toEqual([
      "YouBuild a website.",
      "Agreement assistantRecorded a website milestone.What is the total payment?",
      "YouThe total is 1 ETH.",
      "Agreement assistantThe total is now 1 ETH.Which wallet will deposit and approve?",
    ]);
    expect(screen.getAllByText("Which wallet will deposit and approve?")).toHaveLength(1);
    expect(
      screen.getByText("Which wallet will receive payment?").closest("details"),
    ).not.toHaveAttribute("open");
    expect(screen.getByText("Other items to resolve (1)")).toBeTruthy();
    first.unmount();
    openPage(<CreatePage />);
    await screen.findByText("The total is now 1 ETH.");
    expect(within(screen.getByRole("log")).getAllByText("Agreement assistant")).toHaveLength(2);
    expect(api.sendDraftMessage).not.toHaveBeenCalled();
    expect(api.createDraft).not.toHaveBeenCalled();
  });
  it("keeps English prompts and local-account messages after address-only replies", async () => {
    const draft: DraftSession = {
      ...ready,
      revision: 2,
      messages: [
        { role: "user", content: "Build a website for a total of 1 ETH." },
        { role: "user", content: context.clientWallet },
      ],
      turns: [
        {
          revision: 1,
          reply: "The website delivery and total of 1 ETH are recorded.",
          question: { field: "clientWallet", question: "What is the client wallet address?" },
        },
        {
          revision: 2,
          reply: "The client wallet is updated.",
          question: { field: "developerWallet", question: "What is the provider wallet address?" },
        },
      ],
      result: {
        ...ready.result!,
        status: "needsClarification",
        questions: [{ field: "developerWallet", question: "What is the provider wallet address?" }],
      },
    };
    api.setActiveDraftId(draft.id);
    vi.mocked(api.getDraft).mockResolvedValue(draft);
    openPage(<CreatePage />);
    await screen.findByText("The client wallet is updated.");
    expect(screen.getByText("Build a website for a total of 1 ETH.")).toBeTruthy();
    expect(screen.getByText("Payment summary")).toBeTruthy();
    expect(screen.getAllByText("What is the provider wallet address?")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Review agreement" })).toBeDisabled();
    expect(api.sendDraftMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use local test accounts" }));
    await waitFor(() => expect(api.sendDraftMessage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.sendDraftMessage).mock.calls[0]![1]).toBe(
      `For this local test, use ${context.clientWallet} as the client wallet and ${context.developerWallet} as the provider wallet.`,
    );
  });
  it("loads older sessions without inventing assistant replies for previous messages", async () => {
    const draft: DraftSession = {
      ...ready,
      messages: [
        { role: "user", content: "Build a website." },
        { role: "user", content: "The total is 1 ETH." },
      ],
    };
    api.setActiveDraftId(draft.id);
    vi.mocked(api.getDraft).mockResolvedValue(draft);
    openPage(<CreatePage />);
    await screen.findByText("The total is 1 ETH.");
    const log = screen.getByRole("log");
    expect(within(log).getAllByText("Agreement assistant")).toHaveLength(1);
    expect(
      within(log).getByText(
        "Your current payment summary is loaded. Check the rules alongside this conversation.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review agreement" })).toBeEnabled();
  });
  it("recovers a completed reply after a lost response without submitting it again", async () => {
    api.setActiveDraftId(empty.id);
    openPage(<CreatePage />);
    vi.mocked(api.sendDraftMessage).mockImplementation(async () => {
      vi.mocked(api.getDraft).mockResolvedValue(ready);
      throw new Error("Connection lost");
    });
    type("Build a website for 1 ETH.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("The payment details are ready for your review.");
    expect(screen.getByLabelText("Describe your agreement or add a detail")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Review agreement" })).toBeEnabled(),
    );
    expect(api.sendDraftMessage).toHaveBeenCalledTimes(1);
  });
  it("sends only on a click, blocks duplicate submission, and restores from the saved draft ID", async () => {
    let finish!: (value: DraftSession) => void;
    vi.mocked(api.sendDraftMessage).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = openPage(<CreatePage />);
    expect(api.createDraft).not.toHaveBeenCalled();
    type("Build a website for 1 ETH.");
    const button = screen.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(api.sendDraftMessage).toHaveBeenCalledTimes(1));
    finish(ready);
    await screen.findByText("The payment details are ready for your review.");
    expect(sessionStorage.length).toBe(1);
    expect(api.getActiveDraftId()).toBe(ready.id);
    expect(api.confirmDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review agreement" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/confirm" });
    first.unmount();
    vi.mocked(api.getDraft).mockResolvedValue(ready);
    openPage(<CreatePage />);
    await screen.findByText("Build a website for 1 ETH.");
    expect(api.createDraft).toHaveBeenCalledTimes(1);
    expect(api.sendDraftMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByText("We will document maintenance separately.")).toBeTruthy();
  });
  it("offers the local accounts only when the assistant asks for a wallet", async () => {
    // The backend fills the built-in accounts, so a first-time user never sees this button.
    openPage(<CreatePage />);
    type("Build a website for 1 ETH.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    expect(screen.queryByText("Use local test accounts")).toBeNull();
  });
  it.each(["needsClarification", "unsupported"] as const)(
    "keeps %s drafts out of review and confirmation",
    async (status) => {
      const draft: DraftSession = {
        ...ready,
        result: {
          ...ready.result!,
          status,
          questions:
            status === "needsClarification"
              ? [{ field: "amount", question: "What amount should be paid?" }]
              : [],
          unsupportedTerms: status === "unsupported" ? ["Automatic refunds are required."] : [],
        },
      };
      api.setActiveDraftId(draft.id);
      vi.mocked(api.getDraft).mockResolvedValue(draft);
      const first = openPage(<CreatePage />);
      await screen.findByText("Payment summary");
      expect(screen.getByRole("button", { name: "Review agreement" })).toBeDisabled();
      first.unmount();
      openPage(<ConfirmPage />);
      await screen.findByText("Payment summary");
      fireEvent.click(screen.getByRole("checkbox"));
      expect(screen.getByRole("button", { name: "Confirm agreement" })).toBeDisabled();
      expect(api.confirmDraft).not.toHaveBeenCalled();
    },
  );
  it("restores a failed pending message and retries its original key and revision", async () => {
    const failed: DraftSession = {
      ...ready,
      lastError: "The drafting service timed out",
      pendingMessage: {
        content: "Change the price to 2 ETH.",
        requestKey: "original-key",
        expectedRevision: 1,
      },
    };
    api.setActiveDraftId(failed.id);
    vi.mocked(api.getDraft).mockResolvedValue(failed);
    openPage(<CreatePage />);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Review agreement" })).toBeDisabled();
    expect(screen.getByLabelText("Describe your agreement or add a detail")).toHaveValue(
      failed.pendingMessage!.content,
    );
    expect(api.sendDraftMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry this message" }));
    await waitFor(() =>
      expect(api.sendDraftMessage).toHaveBeenCalledWith(
        failed.id,
        "Change the price to 2 ETH.",
        1,
        "original-key",
      ),
    );
  });
  it("restores busy state using reads and never automatically replays a request", async () => {
    const draft = {
      ...ready,
      busy: true,
      pendingMessage: { content: "Update it", expectedRevision: 1, requestKey: "pending" },
    };
    api.setActiveDraftId(draft.id);
    vi.mocked(api.getDraft).mockResolvedValue(draft);
    openPage(<CreatePage />);
    await screen.findByText("Updating agreement…");
    expect(screen.getByRole("button", { name: "Review agreement" })).toBeDisabled();
    expect(api.sendDraftMessage).not.toHaveBeenCalled();
    expect(api.createDraft).not.toHaveBeenCalled();
  });
  it("shows request failures and never replaces them with simulated results", async () => {
    vi.mocked(api.sendDraftMessage).mockRejectedValue(new Error("Draft service unavailable"));
    openPage(<CreatePage />);
    type("Build a website");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Draft service unavailable"),
    );
    expect(screen.queryByText("Payment summary")).toBeNull();
    expect(screen.getByRole("button", { name: "Review agreement" })).toBeDisabled();
  });
  it("keeps an unavailable saved draft visible until the user starts a new agreement", async () => {
    api.setActiveDraftId("missing");
    vi.mocked(api.getDraft).mockRejectedValue(new Error("Draft not found"));
    openPage(<CreatePage />);
    await screen.findByRole("alert");
    expect(api.createDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start a new agreement" }));
    expect(api.getActiveDraftId()).toBeNull();
    expect(api.createDraft).not.toHaveBeenCalled();
  });
  it("resumes a saved draft after a temporary read failure without a new assistant request", async () => {
    api.setActiveDraftId(ready.id);
    vi.mocked(api.getDraft)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(ready);
    openPage(<CreatePage />);
    await screen.findByText("Reconnecting to the local server to check your saved draft.");
    expect(await screen.findByRole("button", { name: "Review agreement" })).toBeDisabled();
    await waitFor(
      () => expect(screen.getByRole("button", { name: "Review agreement" })).toBeEnabled(),
      { timeout: 4500 },
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.sendDraftMessage).not.toHaveBeenCalled();
    expect(api.createDraft).not.toHaveBeenCalled();
  });
});

describe("explicit agreement confirmation", () => {
  it("requires acknowledgement and one explicit confirmation before opening the project", async () => {
    let finish!: (value: { project: Project; agreement: AgreementContext }) => void;
    vi.mocked(api.confirmDraft).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await openReady();
    await screen.findByText("Payment summary");
    const button = screen.getByRole("button", { name: "Confirm agreement" });
    expect(button).toBeDisabled();
    expect(api.confirmDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(api.confirmDraft).toHaveBeenCalledTimes(1));
    expect(api.confirmDraft).toHaveBeenCalledWith(ready.id, ready.revision);
    expect(navigate).not.toHaveBeenCalled();
    finish({ project, agreement });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/projects/$id", params: { id: project.id } }),
    );
  });
  it("starts generating the contract as soon as the agreement is confirmed", async () => {
    await openReady();
    await screen.findByText("Payment summary");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm agreement" }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/projects/$id", params: { id: project.id } }),
    );
    expect(api.startGeneration).toHaveBeenCalledWith(project.id, agreement);
  });
  it("still opens the project when generation is off or cannot start", async () => {
    vi.mocked(api.confirmDraft).mockResolvedValue({
      project,
      agreement: { ...agreement, generationEnabled: false },
    });
    await openReady();
    await screen.findByText("Payment summary");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm agreement" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(api.startGeneration).not.toHaveBeenCalled();
  });
  it("opens the project even if generation could not start", async () => {
    vi.mocked(api.startGeneration).mockRejectedValue(new Error("busy"));
    await openReady();
    await screen.findByText("Payment summary");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm agreement" }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/projects/$id", params: { id: project.id } }),
    );
  });
  it("recovers the same confirmed project when the confirmation response is lost", async () => {
    await openReady();
    await screen.findByText("Payment summary");
    vi.mocked(api.confirmDraft).mockRejectedValue(new Error("Connection lost"));
    vi.mocked(api.getDraft).mockResolvedValue({ ...ready, confirmedProjectId: project.id });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm agreement" }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/projects/$id", params: { id: project.id } }),
    );
    expect(api.confirmDraft).toHaveBeenCalledTimes(1);
  });
  it("lists conditions moved out of the contract on the review page", async () => {
    api.setActiveDraftId(ready.id);
    vi.mocked(api.getDraft).mockResolvedValue({
      ...ready,
      settledTerms: ["payment due June 30, 2026"],
    });
    openPage(<ConfirmPage />);
    expect(await screen.findByText("Not enforced by the contract")).toBeVisible();
    expect(screen.getByText("payment due June 30, 2026")).toBeVisible();
  });
  it("folds a long list of conditions from an uploaded contract after the first five", async () => {
    api.setActiveDraftId(ready.id);
    const terms = Array.from({ length: 8 }, (_, n) => `condition ${n + 1}`);
    vi.mocked(api.getDraft).mockResolvedValue({ ...ready, settledTerms: terms });
    openPage(<ConfirmPage />);
    expect(await screen.findByText("condition 5")).toBeVisible();
    expect(screen.getByText("condition 6")).not.toBeVisible();
    fireEvent.click(screen.getByText("Show 3 more conditions"));
    expect(screen.getByText("condition 8")).toBeVisible();
  });
  it("shows how amounts in another currency became test ETH", async () => {
    api.setActiveDraftId(ready.id);
    vi.mocked(api.getDraft).mockResolvedValue({
      ...ready,
      result: {
        ...ready.result!,
        exchangeRates: [
          {
            currency: "USD",
            unitsPerEth: "1667.36",
            source: "live",
            asOf: "2026-11-27T17:40:00Z",
            provider: "CoinGecko",
          },
        ],
      },
      settledTerms: ["refund if delivery is late"],
    });
    openPage(<ConfirmPage />);
    expect(
      await screen.findByText("Rate: 1 test ETH = 1,667.36 USD (live rate, CoinGecko 17:40 UTC)."),
    ).toBeVisible();
    // 1 test ETH at that rate is 1,667.36 USD, shown in the agreed currency first.
    // Total and the single milestone both show it.
    expect(screen.getAllByText("1,667.36 USD (1 test ETH)").length).toBeGreaterThan(0);
    expect(screen.getByText(/does not enforce are not part of them/)).toBeVisible();
  });
  it("clears acknowledgement after a revision conflict and requires reviewing again", async () => {
    await openReady();
    await screen.findByText("Payment summary");
    vi.mocked(api.confirmDraft).mockRejectedValueOnce(new Error("Agreement changed"));
    vi.mocked(api.getDraft).mockResolvedValue({ ...ready, revision: 2 });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm agreement" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
    expect(screen.getByRole("button", { name: "Confirm agreement" })).toBeDisabled();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("keeps confirmed drafts sealed after a refresh", async () => {
    api.setActiveDraftId(ready.id);
    vi.mocked(api.getDraft).mockResolvedValue({ ...ready, confirmedProjectId: project.id });
    openPage(<CreatePage />);
    await screen.findByText("Open confirmed project");
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Review agreement" })).toBeNull();
    expect(api.confirmDraft).not.toHaveBeenCalled();
  });
});

describe("honest generation results", () => {
  const run: GenerationRun = {
    schemaVersion: 1,
    id: "r",
    projectId: "p",
    specVersion: 1,
    confirmationId: "c",
    status: "completed",
    createdAt: "",
    finishedAt: "",
    result: { status: "failed", sourceBundle: null, validationReport: null, attempts: [] },
    error: null,
    generatedDeploymentEnabled: false,
  };
  const checked: GenerationRun = {
    ...run,
    result: {
      ...run.result!,
      attempts: [{ attempt: 0, sourceHash: "h", reportId: "rep", feedbackUsed: [] }],
    },
  };
  it("completed transport with failed checks is not displayed as a pass", () => {
    render(<GenerationResultView run={checked} currentVersion={1} />);
    expect(screen.getByText("Contract checks did not pass")).toBeTruthy();
    expect(screen.queryByText("Automatic checks passed")).toBeNull();
    expect(screen.queryByRole("button", { name: /deploy/i })).toBeNull();
  });
  it("explains a model reply without a contract instead of reporting failed checks", () => {
    render(<GenerationResultView run={run} currentVersion={1} />);
    expect(screen.getByText("The AI model did not return a contract")).toBeTruthy();
    expect(screen.getByText(/no checks ran and nothing can be deployed/)).toBeTruthy();
    expect(screen.queryByText("Contract checks did not pass")).toBeNull();
    expect(screen.queryByText(/Recorded attempts/)).toBeNull();
  });
  it("discards results belonging to an older agreement version", () => {
    render(<GenerationResultView run={run} currentVersion={2} />);
    expect(screen.getByText("These results are out of date")).toBeTruthy();
    expect(screen.queryByText("Contract checks did not pass")).toBeNull();
  });
});
