import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationAssistant } from "@/components/OperationAssistant";
import { api, type OperationPlan, type Project } from "@/api/client";

const project: Project = {
  schemaVersion: 2,
  id: "p1",
  name: "Site",
  clientWallet: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  developerWallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  createdAt: "2026-11-10T00:00:00Z",
  totalAmountWei: "10",
  escrowBalanceWei: "10",
  contractAddress: "0x1111111111111111111111111111111111111111",
  funded: true,
  milestones: [{ id: 1, title: "Homepage", amountWei: "10", paid: false }],
  transactions: [],
};
const ready = (action: "query" | "acceptMilestone"): OperationPlan => ({
  planId: "plan-1",
  status: "readyForConfirmation",
  question: null,
  summary: "Accept milestone #1. No transaction has been sent.",
  intent: {
    projectId: "p1",
    chainId: 31337,
    contractAddress: project.contractAddress!,
    action,
    milestoneId: action === "acceptMilestone" ? 1 : null,
  },
});
const type = (text: string) =>
  fireEvent.change(screen.getByLabelText("Your request (English or Chinese)"), {
    target: { value: text },
  });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("plain-language operations", () => {
  it("sends nothing until the user confirms, then shows the receipt report", async () => {
    const plan = vi.spyOn(api, "planOperation").mockResolvedValue(ready("acceptMilestone"));
    const paid = { ...project, milestones: [{ ...project.milestones[0]!, paid: true }] };
    const confirm = vi.spyOn(api, "confirmOperation").mockResolvedValue({
      report: { outcome: "confirmed", summary: 'Milestone #1 "Homepage" is paid.' },
      project: paid,
    });
    const onProject = vi.fn();
    render(<OperationAssistant project={project} disabled={false} onProject={onProject} />);
    type("approve the first milestone");
    fireEvent.click(screen.getByText("Ask"));
    await screen.findByText("Accept milestone #1. No transaction has been sent.");
    expect(plan).toHaveBeenCalledWith("p1", "approve the first milestone");
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm and send"));
    await screen.findByText('Milestone #1 "Homepage" is paid.');
    expect(confirm).toHaveBeenCalledWith("p1", "plan-1");
    expect(onProject).toHaveBeenCalledWith(paid);
  });
  it("offers no confirm button for a query, a question or a refusal", async () => {
    const plan = vi.spyOn(api, "planOperation");
    render(<OperationAssistant project={project} disabled={false} onProject={vi.fn()} />);
    for (const result of [
      ready("query"),
      {
        ...ready("query"),
        status: "needsClarification",
        intent: null,
        question: "Which milestone?",
      },
      { ...ready("query"), status: "blocked", intent: null, summary: "Not supported." },
    ] as OperationPlan[]) {
      plan.mockResolvedValueOnce(result);
      type("something");
      fireEvent.click(screen.getByText("Ask"));
      await screen.findByText(result.question ?? result.summary);
      expect(screen.queryByText("Confirm and send")).toBeNull();
    }
  });
  it("shows a failed report as a failure and a backend error as an error", async () => {
    vi.spyOn(api, "planOperation").mockResolvedValue(ready("acceptMilestone"));
    vi.spyOn(api, "confirmOperation")
      .mockResolvedValueOnce({
        report: { outcome: "failed", summary: "The transaction failed, so nothing changed." },
        project,
      })
      .mockRejectedValueOnce(new Error("The escrow state changed after this plan was made."));
    render(<OperationAssistant project={project} disabled={false} onProject={vi.fn()} />);
    for (const text of [
      "The transaction failed, so nothing changed.",
      "The escrow state changed after this plan was made.",
    ]) {
      type("approve 1");
      fireEvent.click(screen.getByText("Ask"));
      fireEvent.click(await screen.findByText("Confirm and send"));
      const shown = await screen.findByText(text);
      expect(shown.className).toContain("text-destructive");
      await waitFor(() => expect(screen.queryByText("Confirm and send")).toBeNull());
    }
  });
  it("cannot ask before the contract is deployed", () => {
    render(
      <OperationAssistant
        project={{ ...project, contractAddress: null }}
        disabled={false}
        onProject={vi.fn()}
      />,
    );
    type("deposit");
    expect((screen.getByText("Ask") as HTMLButtonElement).disabled).toBe(true);
  });
});
