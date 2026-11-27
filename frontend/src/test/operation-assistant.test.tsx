import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { useState } from "react";
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
const ready = (action: "query" | "deposit" | "acceptMilestone"): OperationPlan => ({
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

const schedule = {
  ...project,
  totalAmountWei: "10000000000000000",
  escrowBalanceWei: "10000000000000000",
  milestones: [
    { id: 1, title: "Homepage", amountWei: "3000000000000000", paid: false },
    { id: 2, title: "Checkout", amountWei: "7000000000000000", paid: false },
  ],
};
function buttonPlan(action: "deposit" | "acceptMilestone"): OperationPlan {
  return { ...ready(action), payment: {
    amountWei: action === "deposit" ? schedule.totalAmountWei : schedule.milestones[0]!.amountWei,
    from: action === "deposit" ? schedule.clientWallet : schedule.contractAddress!,
    to: action === "deposit" ? schedule.contractAddress! : schedule.developerWallet,
    milestoneTitle: action === "deposit" ? null : schedule.milestones[0]!.title,
  } };
}
function PaymentPanel({ initial }: { initial: Project }) {
  const [current, setCurrent] = useState(initial);
  return <OperationAssistant project={current} disabled={false} onProject={setCurrent} quickActions naturalLanguageEnabled={false} />;
}
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

describe("payment buttons", () => {
  it("previews a Chinese deposit beside its button and sends only after a second, single confirmation", async () => {
    let planned!: (value: OperationPlan) => void;
    let completed!: (value: Awaited<ReturnType<typeof api.confirmOperation>>) => void;
    const known = vi.spyOn(api, "planKnownOperation").mockImplementation(() => new Promise(resolve => { planned = resolve; }));
    const natural = vi.spyOn(api, "planOperation");
    const confirm = vi.spyOn(api, "confirmOperation").mockImplementation(() => new Promise(resolve => { completed = resolve; }));
    const onProject = vi.fn();
    render(<OperationAssistant project={{ ...schedule, funded: false, escrowBalanceWei: "0" }} disabled={false}
      onProject={onProject} quickActions language="zh" />);
    const deposit = screen.getByRole("button", { name: "存入 0.01 测试 ETH" });
    fireEvent.click(deposit);
    fireEvent.click(deposit);
    expect(known).toHaveBeenCalledTimes(1);
    expect(known).toHaveBeenCalledWith("p1", { action: "deposit" });
    expect(confirm).not.toHaveBeenCalled();
    planned(buttonPlan("deposit"));
    const approve = await screen.findByRole("button", { name: "确认存款" });
    const preview = screen.getByLabelText("付款确认信息");
    expect(preview).toHaveTextContent("0.01 测试 ETH");
    expect(preview).toHaveTextContent(schedule.contractAddress!);
    expect(preview).toHaveTextContent("没有退款或超时放款");
    expect(preview).toHaveTextContent("这笔转账无法撤回");
    expect(preview.compareDocumentPosition(screen.getByLabelText("你的请求")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("Review a deposit")).toBeNull();
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith("p1", "plan-1");
    completed({ project: schedule, report: { outcome: "confirmed", summary: "存款已确认。" } });
    await screen.findByText("存款已确认。");
    expect(onProject).toHaveBeenCalledWith(schedule);
    expect(natural).not.toHaveBeenCalled();
  });

  it("accepts the first unpaid milestone, updates its receipt state and offers only the next payment", async () => {
    const known = vi.spyOn(api, "planKnownOperation").mockResolvedValue(buttonPlan("acceptMilestone"));
    const natural = vi.spyOn(api, "planOperation");
    const paid = { ...schedule, escrowBalanceWei: "7000000000000000",
      milestones: schedule.milestones.map(m => ({ ...m, paid: m.id === 1 })) };
    const confirm = vi.spyOn(api, "confirmOperation").mockResolvedValue({
      project: paid, report: { outcome: "confirmed", summary: "Homepage payment confirmed." },
    });
    render(<PaymentPanel initial={schedule} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept milestone 1 and pay 0.003 test ETH" }));
    const approve = await screen.findByRole("button", { name: "Confirm acceptance and payment" });
    expect(screen.getByLabelText("Payment confirmation details")).toHaveTextContent(schedule.developerWallet);
    expect(screen.getByLabelText("Payment confirmation details")).toHaveTextContent('accepts milestone #1 "Homepage"');
    expect(screen.getByLabelText("Payment confirmation details")).toHaveTextContent("this transfer cannot be reversed");
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(approve);
    await screen.findByRole("button", { name: "Accept milestone 2 and pay 0.007 test ETH" });
    expect(screen.queryByRole("button", { name: /Accept milestone 1/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
    expect(known).toHaveBeenCalledWith("p1", { action: "acceptMilestone", milestoneId: 1 });
    expect(known).toHaveBeenCalledTimes(1);
    expect(natural).not.toHaveBeenCalled();
  });

  it("refreshes state after a lost confirmation response instead of resending a deposit", async () => {
    const known = vi.spyOn(api, "planKnownOperation").mockResolvedValue(buttonPlan("deposit"));
    const confirm = vi.spyOn(api, "confirmOperation").mockRejectedValue(new Error("Connection lost after submission"));
    const refresh = vi.spyOn(api, "getProjectSnapshot").mockResolvedValue(schedule);
    render(<PaymentPanel initial={{ ...schedule, funded: false, escrowBalanceWei: "0" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Deposit 0.01 test ETH" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm deposit" }));
    await screen.findByRole("button", { name: "Accept milestone 1 and pay 0.003 test ETH" });
    expect(screen.queryByRole("button", { name: "Deposit 0.01 test ETH" })).toBeNull();
    expect(screen.getByText("Connection lost after submission")).toHaveClass("text-destructive");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(known).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("p1");
  });

  it("does not offer another payment after completion or submit while disabled", () => {
    const known = vi.spyOn(api, "planKnownOperation");
    const first = render(<PaymentPanel initial={{ ...schedule, milestones: schedule.milestones.map(m => ({ ...m, paid: true })) }} />);
    expect(screen.getByText("All milestones paid.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Accept milestone/ })).toBeNull();
    first.unmount();
    render(<OperationAssistant project={schedule} disabled onProject={vi.fn()} quickActions naturalLanguageEnabled={false} />);
    const pay = screen.getByRole("button", { name: /Accept milestone 1/ });
    expect(pay).toBeDisabled();
    fireEvent.click(pay);
    expect(known).not.toHaveBeenCalled();
  });
});
