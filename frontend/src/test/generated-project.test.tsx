import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type AgreementContext, type GenerationRun, type Project } from "@/api/client";
import { DetailPage } from "@/routes/projects.$id";
import { ReferenceProject } from "@/routes/reference-projects.$id";

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
  it("loads the server conversation and keeps confirmed conversation terms sealed", async () => {
    serve(project, { ...context, draftOrigin: { draftId: "draft-origin", revision: 1 } }, run);
    const getDraft = vi.spyOn(api, "getDraft").mockResolvedValue({
      id: "draft-origin",
      revision: 1,
      createdAt: "",
      updatedAt: "",
      busy: false,
      pendingMessage: null,
      lastError: null,
      confirmedProjectId: project.id,
      messages: [
        { role: "user", content: "This is the website agreement approved by both parties." },
      ],
      result: {
        status: "readyForConfirmation",
        draftSpec: context.spec,
        questions: [],
        unsupportedTerms: [],
        separateTerms: ["Maintenance will be agreed separately."],
      },
    });
    openPage();
    await screen.findByText("This is the website agreement approved by both parties.");
    expect(getDraft).toHaveBeenCalledWith("draft-origin");
    expect(screen.getByText("Maintenance will be agreed separately.")).toBeTruthy();
    expect(screen.queryByText("Add or change agreement details")).toBeNull();
    expect(screen.getByText("Start a new agreement to change these terms")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start another generation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deploy generated contract locally" })).toBeTruthy();
  });
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
    fireEvent.change(screen.getByLabelText("Your request"), {
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
    expect(screen.getByRole("button", { name: /Deposit .* test ETH/ })).toBeEnabled();
  });
  it("keeps payment controls in English for a Chinese project title without source conversation", async () => {
    const projectName = "中文项目名称";
    serve(
      deployed,
      {
        ...context,
        spec: { ...context.spec, name: projectName },
        deployment,
        operationsEnabled: false,
      },
      run,
    );
    openPage();
    await screen.findByRole("button", { name: /Deposit .* test ETH/ });
    expect(screen.getByRole("heading", { name: projectName })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Payment actions" })).toBeTruthy();
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
  it("offers the recovered contract for deployment and explains which chain is visible", async () => {
    serve(project, { ...context, recoveredOnFreshChain: true }, run);
    const deploy = vi.spyOn(api, "deployGeneration");
    const regenerate = vi.spyOn(api, "startGeneration");
    openPage();
    await screen.findByText(/deploy it on this fresh local chain without generating it again/i);
    expect(screen.getByText(/transactions from the previous local chain are unavailable/i)).toBeVisible();
    expect(screen.queryByText("Add or change agreement details")).toBeNull();
    expect(screen.queryByText("Original description & additional terms")).toBeNull();
    expect(screen.getByText("Start a new agreement to change these terms")).toBeVisible();
    expect(screen.getByRole("button", { name: "Deploy generated contract locally" })).toBeEnabled();
    expect(deploy).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
  });
  it("automatically reconnects to a passed run after a lost deployment response without resending it", async () => {
    serve(project, context, run);
    const deploy = vi.spyOn(api, "deployGeneration").mockImplementation(async () => {
      vi.mocked(api.getProjectSnapshot).mockRejectedValueOnce(new TypeError("Failed to fetch"));
      throw new TypeError("Failed to fetch");
    });
    const regenerate = vi.spyOn(api, "startGeneration");
    openPage();
    fireEvent.click(await screen.findByRole("button", { name: "Deploy generated contract locally" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Reconnecting to the local server to check deployment status automatically"));
    expect(screen.getByText("Development checks passed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Deploy generated contract locally" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start another generation" })).toBeDisabled();
    serve(deployed, { ...context, deployment }, { ...run, generatedDeploymentEnabled: false });
    expect(await screen.findByText(deployment.contractAddress, {}, { timeout: 4500 })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(regenerate).not.toHaveBeenCalled();
  });
  it("permits retry of the existing checked version after a status read finds no deployment", async () => {
    serve(project, context, run);
    const deploy = vi.spyOn(api, "deployGeneration").mockRejectedValue(new TypeError("Load failed"));
    const regenerate = vi.spyOn(api, "startGeneration");
    openPage();
    fireEvent.click(await screen.findByRole("button", { name: "Deploy generated contract locally" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("No deployment is recorded"));
    expect(screen.getByRole("button", { name: "Deploy generated contract locally" })).toBeEnabled();
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(regenerate).not.toHaveBeenCalled();
  });
  it("resumes the handwritten reference project with read-only requests after a proxy outage", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockImplementation(async (url) => Response.json(
        String(url).endsWith("/agreement") ? { ...context, latestRunId: null, confirmation: null } : project,
      ));
    render(<QueryClientProvider client={new QueryClient()}><ReferenceProject id="p" /></QueryClientProvider>);
    await screen.findByText("Reconnecting to the local server to check project status automatically.");
    expect(await screen.findByRole("heading", { name: project.name }, { timeout: 4500 })).toBeVisible();
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
});
