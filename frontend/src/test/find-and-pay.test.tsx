import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Project, type ProjectSummary } from "@/api/client";
import { ProjectsPage } from "@/routes/projects.index";
import { ReferenceProject } from "@/routes/reference-projects.$id";
import { MilestoneLedger, ProjectLink } from "@/components/EscrowLedger";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ ...options, useParams: () => ({ id: "p" }) }),
  useNavigate: () => navigate,
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode;
    to: string;
    params?: { id: string };
  }) => <a href={params ? to.replace("$id", params.id) : to}>{children}</a>,
}));

const client = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const developer = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const contract = "0x" + "1".repeat(40);
const project: Project = {
  schemaVersion: 2,
  id: "p",
  name: "Bakery website",
  clientWallet: client,
  developerWallet: developer,
  createdAt: "2026-11-27T00:00:00Z",
  totalAmountWei: "10000000000000000",
  escrowBalanceWei: "7000000000000000",
  contractAddress: contract,
  funded: true,
  milestones: [
    { id: 1, title: "Homepage", amountWei: "3000000000000000", paid: true },
    { id: 2, title: "Full site", amountWei: "7000000000000000", paid: false },
  ],
  transactions: [
    { action: "deploy", hash: "0xdeploy", blockNumber: 1, status: 1 },
    { action: "deposit", hash: "0xdeposit", blockNumber: 2, status: 1 },
    { action: "acceptMilestone", milestoneId: 1, hash: "0xpaid1", blockNumber: 3, status: 1 },
  ],
};
const summary = (changes: Partial<ProjectSummary>): ProjectSummary => ({
  id: "p",
  name: "Bakery website",
  kind: "agreement",
  stage: "paying",
  createdAt: project.createdAt,
  contractAddress: contract,
  funded: true,
  totalAmountWei: project.totalAmountWei,
  escrowBalanceWei: project.escrowBalanceWei,
  milestoneCount: 2,
  paidCount: 1,
  ...changes,
});
function withQuery(children: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>);
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  navigate.mockReset();
});

describe("finding a project again", () => {
  it("lists saved projects with their status and opens each with the matching page", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue([
      summary({}),
      summary({
        id: "r",
        name: "Reference shop",
        kind: "reference",
        stage: "notDeployed",
        contractAddress: null,
        paidCount: 0,
      }),
    ]);
    vi.spyOn(api, "listDrafts").mockResolvedValue([]);
    withQuery(<ProjectsPage />);
    const generated = await screen.findByRole("link", { name: "Bakery website" });
    expect(generated).toHaveAttribute("href", "/projects/p");
    expect(screen.getByRole("link", { name: "Reference shop" })).toHaveAttribute(
      "href",
      "/reference-projects/r",
    );
    expect(screen.getByText("Funded · waiting for milestone approval")).toBeVisible();
    expect(
      screen.getByText(/AI-generated contract · 0.01 test ETH · 1 of 2 milestones paid/),
    ).toBeVisible();
    expect(screen.getByText("Not deployed yet")).toBeVisible();
    expect(screen.queryByText("Unfinished conversations")).toBeNull();
  });
  it("resumes an unfinished conversation from the list", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue([]);
    vi.spyOn(api, "listDrafts").mockResolvedValue([
      {
        id: "d1",
        name: null,
        createdAt: project.createdAt,
        updatedAt: project.createdAt,
        status: "needsClarification",
        messageCount: 1,
        awaitingReply: false,
      },
    ]);
    const select = vi.spyOn(api, "setActiveDraftId");
    withQuery(<ProjectsPage />);
    expect(await screen.findByText("Untitled agreement")).toBeVisible();
    expect(screen.getByText(/Questions still open/)).toBeVisible();
    expect(screen.getByText(/No saved projects yet/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Continue conversation" }));
    expect(select).toHaveBeenCalledWith("d1");
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
  });
  it("explains a restart when the running server predates the project list", async () => {
    vi.spyOn(api, "listProjects").mockRejectedValue(new Error("Endpoint not found"));
    vi.spyOn(api, "listDrafts").mockRejectedValue(new Error("Endpoint not found"));
    withQuery(<ProjectsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Restart the local demo .* Your saved projects are kept/,
    );
  });
  it("copies the project link and offers a manual fallback", async () => {
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ProjectLink />);
    fireEvent.click(screen.getByRole("button", { name: "Copy project link" }));
    expect(await screen.findByText(/Link copied/)).toBeVisible();
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    fireEvent.click(screen.getByRole("button", { name: "Copy project link" }));
    expect(await screen.findByLabelText("Project link")).toHaveValue(window.location.href);
  });
});

describe("milestone payments", () => {
  it("shows each milestone's amount, recipient, paid state and receipt", () => {
    render(<MilestoneLedger project={project} />);
    const [deposit, first, second] = screen.getAllByRole("listitem");
    expect(deposit).toHaveTextContent("Funded");
    expect(deposit).toHaveTextContent(`From ${client}`);
    expect(deposit).toHaveTextContent("Receipt · block 2 · 0xdeposit");
    expect(first).toHaveTextContent("1. Homepage");
    expect(first).toHaveTextContent("0.003 test ETH");
    expect(first).toHaveTextContent("Paid");
    expect(first).toHaveTextContent(`Paid to the developer at ${developer}`);
    expect(first).toHaveTextContent("Receipt · block 3 · 0xpaid1");
    expect(second).toHaveTextContent("Next: waiting for the client's approval");
    expect(second).toHaveTextContent(`Pays the developer at ${developer}`);
    expect(second).not.toHaveTextContent("Receipt");
    expect(screen.getByText("1 of 2 milestones paid")).toBeVisible();
  });
  it("asks for review before a reference deposit or payment and sends nothing on cancel", async () => {
    const unfunded = {
      ...project,
      funded: false,
      escrowBalanceWei: "0",
      transactions: project.transactions.slice(0, 1),
      milestones: project.milestones.map((m) => ({ ...m, paid: false })),
    };
    vi.spyOn(api, "getProject").mockResolvedValue(unfunded);
    vi.spyOn(api, "getAgreement").mockResolvedValue({
      deployment: { kind: "reference" },
      confirmation: null,
      latestRunId: null,
    } as never);
    const run = vi.spyOn(api, "runAction").mockResolvedValue({
      ...unfunded,
      funded: true,
      escrowBalanceWei: unfunded.totalAmountWei,
      transactions: [
        ...unfunded.transactions,
        { action: "deposit", hash: "0xnew", blockNumber: 2, status: 1 },
      ],
    });
    withQuery(<ReferenceProject id="p" />);
    fireEvent.click(await screen.findByRole("button", { name: "Deposit funds" }));
    const details = screen.getByLabelText("Payment confirmation details");
    expect(details).toHaveTextContent("Amount: 0.01 test ETH");
    expect(details).toHaveTextContent(`into escrow contract ${contract}`);
    expect(details).toHaveTextContent("cannot be reversed");
    fireEvent.click(within(details).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Payment confirmation details")).toBeNull();
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Deposit funds" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm deposit" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledWith("p", { action: "deposit" });
    expect(await screen.findByText(/Deposit funds succeeded/)).toBeVisible();
  });
  it("explains that a stale second confirmation sent nothing when another tab already paid", async () => {
    const reviewed = { ...project };
    const paid = {
      ...project,
      escrowBalanceWei: "0",
      milestones: project.milestones.map((m) => ({ ...m, paid: true })),
      transactions: [
        ...project.transactions,
        { action: "acceptMilestone", milestoneId: 2, hash: "0xpaid2", blockNumber: 4, status: 1 },
      ],
    };
    const read = vi.spyOn(api, "getProject").mockResolvedValue(reviewed);
    vi.spyOn(api, "getAgreement").mockResolvedValue({
      deployment: { kind: "reference" },
      confirmation: null,
      latestRunId: null,
    } as never);
    const run = vi
      .spyOn(api, "runAction")
      .mockRejectedValue(new Error("Contract rejected this action."));
    withQuery(<ReferenceProject id="p" />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve milestone 2 payment" }));
    expect(screen.getByLabelText("Payment confirmation details")).toHaveTextContent(
      `Recipient: the developer at ${developer}`,
    );
    read.mockResolvedValue(paid);
    fireEvent.click(screen.getByRole("button", { name: "Confirm acceptance and payment" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Nothing new was sent: milestone 2 already paid. Its receipt is shown above.",
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Receipt · block 4 · 0xpaid2/)).toBeVisible();
  });
});
