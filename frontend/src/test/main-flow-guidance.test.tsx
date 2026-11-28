import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type GenerationRun } from "@/api/client";
import type { DraftSession } from "@/api/types";
import { Shell } from "@/components/Shell";
import { GenerationResultView } from "@/components/GenerationResultView";
import { CreatePage } from "@/routes/index";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => options,
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

const wallets = {
  clarificationEnabled: true,
  mode: "local-chain" as const,
  clientWallet: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  developerWallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
};
function openPage(page: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
}
function run(changes: Partial<NonNullable<GenerationRun["result"]>>): GenerationRun {
  const sourceHash = "sha256:" + "b".repeat(64);
  const passed = changes.status !== "failed";
  return {
    schemaVersion: 1,
    id: "r",
    projectId: "p",
    specVersion: 1,
    confirmationId: "c",
    createdAt: "",
    finishedAt: "2026-11-27T00:00:00Z",
    status: "completed",
    error: null,
    generatedDeploymentEnabled: passed,
    result: {
      status: "validated",
      attempts: [{ attempt: 0, sourceHash, reportId: "r1", feedbackUsed: [] }],
      sourceBundle: null,
      validationReport: {
        reportId: "r1",
        projectId: "p",
        specVersion: 1,
        suiteVersion: "fixture",
        mode: "development",
        sourceHash,
        status: passed ? "passed" : "failed",
        checks: [
          { name: "compilation", status: "passed", findings: [] },
          { name: "staticAnalysis", status: "passed", findings: [] },
          {
            name: "clauseTests",
            status: passed ? "passed" : "failed",
            findings: [
              {
                severity: "info",
                message: passed ? "24/24 clause tests passed" : "Second payment was allowed twice",
              },
            ],
          },
        ],
      },
      ...changes,
    },
  } as GenerationRun;
}
beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(api, "getDraftContext").mockResolvedValue(wallets);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("main flow guidance", () => {
  it("shows where the agreement is in the four-step flow", () => {
    render(
      <Shell step="Set up contract" progress={3}>
        <p>Page</p>
      </Shell>,
    );
    const steps = within(screen.getByRole("list", { name: "Agreement progress" })).getAllByRole(
      "listitem",
    );
    expect(steps.map((step) => step.textContent)).toEqual([
      "✓Describe(done)",
      "✓Confirm(done)",
      "3Set up contract",
      "4Fund & pay",
    ]);
    expect(steps[2]).toHaveAttribute("aria-current", "step");
  });
  it("summarizes passed checks in plain words and keeps details one click away", () => {
    render(<GenerationResultView run={run({})} currentVersion={1} />);
    expect(screen.getByText(/24\/24 payment-rule tests passed/)).toBeVisible();
    const details = screen.getByText("Technical details: checks").closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(within(details!).getByText("Compilation")).toBeTruthy();
  });
  it("keeps failed checks open so the reason is visible", () => {
    render(<GenerationResultView run={run({ status: "failed" })} currentVersion={1} />);
    expect(screen.queryByText("Technical details: checks")).toBeNull();
    expect(screen.getByText(/Second payment was allowed twice/)).toBeVisible();
  });
  it("fills an example description without sending it", async () => {
    const send = vi.spyOn(api, "sendDraftMessage");
    const create = vi.spyOn(api, "createDraft");
    openPage(<CreatePage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Not sure what to write? Fill in an example" }),
    );
    const box = screen.getByLabelText<HTMLTextAreaElement>(
      "Describe your agreement or add a detail",
    );
    expect(box.value).toContain("for $1,000");
    expect(send).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it("points a wallet question to the test accounts", async () => {
    const session: DraftSession = {
      id: "d",
      revision: 1,
      createdAt: "",
      updatedAt: "",
      messages: [{ role: "user", content: "Website for my bakery, 0.01 ETH in two milestones." }],
      turns: [
        {
          revision: 1,
          reply: "The total is recorded as 0.01 ETH.",
          question: {
            field: "clientWallet",
            question: "What wallet address will the client use to fund the contract?",
          },
        },
      ],
      result: null,
      busy: false,
      pendingMessage: null,
      lastError: null,
      confirmedProjectId: null,
    };
    api.setActiveDraftId("d");
    vi.spyOn(api, "getDraft").mockResolvedValue(session);
    openPage(<CreatePage />);
    expect(await screen.findByText(/two built-in test accounts sign for the client/)).toBeVisible();
    expect(screen.queryByText(/Fill in an example/)).toBeNull();
  });
});
