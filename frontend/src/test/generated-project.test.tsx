import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type AgreementContext, type GenerationRun, type Project } from "@/api/client";
import { DetailPage } from "@/routes/projects.$id";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ ...options, useParams: () => ({ id: "p" }) }),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

const project: Project = {
  schemaVersion: 2,
  id: "p",
  name: "Website",
  clientWallet: "client",
  developerWallet: "developer",
  createdAt: "2026-11-10T00:00:00Z",
  totalAmountWei: "10",
  escrowBalanceWei: "0",
  funded: false,
  contractAddress: null,
  transactions: [],
  milestones: [{ id: 1, title: "Homepage", amountWei: "10", paid: false }],
};
const context: AgreementContext = {
  interfaceVersion: 1,
  latestRunId: "r",
  generationEnabled: true,
  generatedDeploymentEnabled: true,
  operationsEnabled: true,
  deployment: null,
  confirmation: {
    projectId: "p",
    specVersion: 1,
    confirmationId: "c",
    confirmedAt: project.createdAt,
  },
  spec: {
    schemaVersion: 1,
    projectId: "p",
    specVersion: 1,
    name: project.name,
    clientWallet: project.clientWallet,
    developerWallet: project.developerWallet,
    totalAmountWei: "10",
    milestones: [{ id: 1, title: "Homepage", amountWei: "10" }],
    approvalRole: "client",
    refundPolicy: "none",
    deadline: null,
  },
};
const sourceHash = "sha256:" + "a".repeat(64);
const buildSettings = { evmVersion: "paris", optimizer: { enabled: true, runs: 200 } } as const;
const run: GenerationRun = {
  schemaVersion: 1,
  id: "r",
  projectId: "p",
  specVersion: 1,
  confirmationId: "c",
  createdAt: project.createdAt,
  finishedAt: project.createdAt,
  status: "completed",
  error: null,
  generatedDeploymentEnabled: true,
  result: {
    status: "validated",
    attempts: [{ attempt: 0, sourceHash, reportId: "fixture-report", feedbackUsed: [] }],
    sourceBundle: {
      projectId: "p",
      specVersion: 1,
      sources: { "Escrow.sol": "contract Escrow {}" },
      entryFile: "Escrow.sol",
      entryContract: "Escrow",
      compilerVersion: "0.8.28",
      buildSettings,
      dependencies: [],
      sourceHash,
    },
    validationReport: {
      reportId: "fixture-report",
      projectId: "p",
      specVersion: 1,
      suiteVersion: "fixture",
      mode: "development",
      sourceHash,
      status: "passed",
      checks: [
        { name: "compilation", status: "passed", findings: [] },
        { name: "staticAnalysis", status: "passed", findings: [] },
        { name: "clauseTests", status: "passed", findings: [] },
      ],
      artifact: {
        abi: [],
        bytecode: "0x00",
        compilerVersion: "0.8.28",
        buildSettings,
        sourceHash,
        constructorTypes: ["address", "address", "uint256[]"],
      },
    },
  },
};
const deployment = {
  kind: "generated" as const,
  runId: "r",
  specVersion: 1,
  sourceHash,
  chainId: 31337,
  contractAddress: "0x" + "1".repeat(40),
};
const deployed = { ...project, contractAddress: deployment.contractAddress };
function serve(snapshot: Project, agreement: AgreementContext, generation: GenerationRun) {
  vi.spyOn(api, "getProjectSnapshot").mockResolvedValue(snapshot);
  vi.spyOn(api, "getAgreement").mockResolvedValue(agreement);
  vi.spyOn(api, "getGeneration").mockResolvedValue(generation);
}
function openPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DetailPage id="p" />
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("generated project operations", () => {
  it("deploys only on click, restores the generated contract after reload and updates the escrow after confirmation", async () => {
    serve(project, context, run);
    const deploy = vi.spyOn(api, "deployGeneration").mockImplementation(async () => {
      serve(deployed, { ...context, deployment }, { ...run, generatedDeploymentEnabled: false });
      return deployed;
    });
    const generate = vi.spyOn(api, "startGeneration");
    const referenceAction = vi.spyOn(api, "runAction");
    const plan = vi.spyOn(api, "planOperation").mockResolvedValue({
      planId: "plan",
      status: "readyForConfirmation",
      summary: "Deposit 10 wei?",
      question: null,
      intent: {
        projectId: "p",
        chainId: 31337,
        contractAddress: deployment.contractAddress,
        action: "deposit",
        milestoneId: null,
      },
    });
    const confirm = vi.spyOn(api, "confirmOperation").mockResolvedValue({
      report: { outcome: "confirmed", summary: "Deposit confirmed." },
      project: {
        ...deployed,
        escrowBalanceWei: "10",
        funded: true,
        transactions: [{ action: "deposit", hash: "test-receipt", blockNumber: 2, status: 1 }],
      },
    });
    const first = openPage();
    const button = await screen.findByRole("button", { name: "Deploy generated contract locally" });
    expect(deploy).not.toHaveBeenCalled();
    expect(screen.queryByText("Ask in plain language")).toBeNull();
    fireEvent.click(button);
    await screen.findByText("Ask in plain language");
    expect(deploy).toHaveBeenCalledWith("p", "r", context.confirmation);
    first.unmount();
    openPage();
    await screen.findByText("Ask in plain language");
    expect(screen.getByText(deployment.contractAddress)).toBeTruthy();
    expect(screen.queryByText("Open reference payment controls")).toBeNull();
    expect(screen.queryByText("Deploy generated contract locally")).toBeNull();
    expect(screen.getByText("Awaiting deposit")).toBeTruthy();
    expect(plan).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Your request (English or Chinese)"), {
      target: { value: "Deposit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const approve = await screen.findByRole("button", { name: "Confirm and send" });
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(approve);
    await screen.findByText("Funded");
    expect(screen.getByText("test-receipt")).toBeTruthy();
    expect(confirm).toHaveBeenCalledWith("p", "plan");
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(referenceAction).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled local capability", { generatedDeploymentEnabled: false }, {}],
    ["ineligible run", {}, { generatedDeploymentEnabled: false }],
    ["missing confirmation", { confirmation: null }, {}],
    ["previous agreement version", {}, { specVersion: 2 }],
    ["old confirmation", {}, { confirmationId: "old" }],
    ["failed checks", {}, { result: { ...run.result!, status: "failed" } }],
    ["obsolete run", {}, { status: "obsolete" }],
  ] as Array<[string, Partial<AgreementContext>, Partial<GenerationRun>]>)(
    "withholds deployment for %s",
    async (_, agreement, generation) => {
      serve(project, { ...context, ...agreement }, { ...run, ...generation });
      openPage();
      await screen.findByRole("heading", { name: "Website" });
      expect(screen.queryByText("Deploy generated contract locally")).toBeNull();
      expect(screen.queryByText("Ask in plain language")).toBeNull();
    },
  );

  it("keeps the handwritten reference at its own controls and hides Agent 3 if generated provenance differs", async () => {
    serve(
      deployed,
      { ...context, deployment: { ...deployment, kind: "reference", runId: null } },
      run,
    );
    const first = openPage();
    await screen.findByText("Open reference payment controls");
    expect(screen.queryByText("Ask in plain language")).toBeNull();
    expect(screen.queryByText("Deploy generated contract locally")).toBeNull();
    first.unmount();
    serve(deployed, { ...context, deployment: { ...deployment, sourceHash: "different" } }, run);
    openPage();
    await screen.findByText(/could not be matched to this project/i);
    expect(screen.queryByText("Open reference payment controls")).toBeNull();
    expect(screen.queryByText("Ask in plain language")).toBeNull();
  });
  it("retains a confirmed deployment when Agent 3 is disabled", async () => {
    serve(deployed, { ...context, deployment, operationsEnabled: false }, run);
    openPage();
    await screen.findByText(/Plain-language operations are disabled/);
    expect(screen.getByText(deployment.contractAddress)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
  });
  it("reports a rejected deployment and keeps Agent 3 unavailable", async () => {
    serve(project, context, run);
    vi.spyOn(api, "deployGeneration").mockRejectedValue(new Error("Deployment rejected"));
    openPage();
    fireEvent.click(await screen.findByText("Deploy generated contract locally"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Deployment rejected"));
    expect(screen.queryByText("Ask in plain language")).toBeNull();
  });
});
