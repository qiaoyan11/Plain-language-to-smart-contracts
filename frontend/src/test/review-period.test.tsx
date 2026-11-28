import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationAssistant } from "@/components/OperationAssistant";
import { MilestoneLedger } from "@/components/EscrowLedger";
import { PaymentRules } from "@/components/AgreementNotes";
import { api, type OperationPlan, type Project } from "@/api/client";
import type { DraftSpec, MilestoneAction } from "@/api/types";
import { durationText } from "@/lib/review";

const DAY = 86400;
const NOW = 1_800_000_000;
const base: Project = {
  schemaVersion: 2,
  id: "p1",
  name: "Brand kit",
  clientWallet: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  developerWallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  createdAt: "2026-11-27T00:00:00Z",
  totalAmountWei: "10000000000000000",
  escrowBalanceWei: "10000000000000000",
  contractAddress: "0x1111111111111111111111111111111111111111",
  funded: true,
  reviewPeriodSeconds: 10 * DAY,
  changeRequestLimit: 2,
  review: { periodSeconds: 10 * DAY, changeRequestLimit: 2, chainTime: NOW },
  milestones: [
    {
      id: 1,
      title: "Logo",
      amountWei: "3000000000000000",
      paid: false,
      deliveredAt: 0,
      changeRequests: 0,
    },
    {
      id: 2,
      title: "Guidelines",
      amountWei: "7000000000000000",
      paid: false,
      deliveredAt: 0,
      changeRequests: 0,
    },
  ],
  transactions: [],
};
const withFirst = (patch: Partial<Project["milestones"][number]>, chainTime = NOW): Project => ({
  ...base,
  review: { ...base.review!, chainTime },
  milestones: base.milestones.map((m) => (m.id === 1 ? { ...m, ...patch } : m)),
});
function plan(
  action: MilestoneAction,
  summary = "Prepared. No transaction has been sent.",
): OperationPlan {
  const pays = action === "acceptMilestone" || action === "claimMilestone";
  return {
    planId: `plan-${action}`,
    status: "readyForConfirmation",
    question: null,
    summary,
    intent: {
      projectId: "p1",
      chainId: 31337,
      contractAddress: base.contractAddress!,
      action,
      milestoneId: 1,
    },
    payment: pays
      ? {
          amountWei: "3000000000000000",
          from: base.contractAddress!,
          to: base.developerWallet,
          milestoneTitle: "Logo",
        }
      : null,
  };
}
function Panel({ initial }: { initial: Project }) {
  const [current, setCurrent] = useState(initial);
  return (
    <>
      <MilestoneLedger project={current} />
      <OperationAssistant
        project={current}
        disabled={false}
        onProject={setCurrent}
        quickActions
        naturalLanguageEnabled={false}
      />
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("review period (v2) payment actions", () => {
  it("lets the provider mark a delivery, then shows the client's review with the time left", async () => {
    const known = vi
      .spyOn(api, "planKnownOperation")
      .mockResolvedValue(
        plan(
          "submitDelivery",
          "Mark milestone #1 “Logo” as delivered. No transaction has been sent.",
        ),
      );
    vi.spyOn(api, "confirmOperation").mockResolvedValue({
      project: withFirst({ deliveredAt: NOW - 2 * DAY }),
      report: { outcome: "confirmed", summary: "Milestone 1 is marked delivered." },
    });
    render(<Panel initial={base} />);
    expect(screen.getByTestId("review-actions")).toHaveTextContent(
      "Not delivered yet. Once the provider marks it delivered, the client has 10 days",
    );
    expect(screen.getByText("Next: waiting for the provider to deliver")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Provider: mark as delivered" }));
    const confirm = await screen.findByRole("button", { name: "Confirm delivery" });
    expect(screen.getByText(/as delivered\. No transaction has been sent/)).toBeTruthy();
    expect(screen.queryByLabelText("Payment confirmation details")).toBeNull();
    fireEvent.click(confirm);
    await screen.findByRole("button", { name: "Client: ask for changes (2 left)" });
    expect(screen.getByTestId("review-actions")).toHaveTextContent("The client has 8 days left");
    expect(screen.getByText("Delivered · 8 days left to review")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Client: approve and pay/ })).toBeEnabled();
    expect(known).toHaveBeenCalledWith("p1", { action: "submitDelivery", milestoneId: 1 });
  });

  it("stops offering change requests once the agreed limit is used", () => {
    const known = vi.spyOn(api, "planKnownOperation");
    render(<Panel initial={withFirst({ deliveredAt: NOW - DAY, changeRequests: 2 })} />);
    const ask = screen.getByRole("button", { name: "Client: ask for changes (0 left)" });
    expect(ask).toBeDisabled();
    fireEvent.click(ask);
    expect(known).not.toHaveBeenCalled();
    expect(
      screen.getByText("No change requests left for this milestone under the agreement."),
    ).toBeTruthy();
    expect(
      screen.getByText("Delivered · 9 days left to review · 2 change requests so far"),
    ).toBeTruthy();
  });

  it("skips to the end of the review on the test chain, then lets the provider claim", async () => {
    const delivered = withFirst({ deliveredAt: NOW - 3 * DAY });
    const advance = vi
      .spyOn(api, "advanceClock")
      .mockResolvedValue(withFirst({ deliveredAt: NOW - 3 * DAY }, NOW + 7 * DAY + 5));
    vi.spyOn(api, "planKnownOperation").mockResolvedValue(plan("claimMilestone"));
    const claimed = {
      ...delivered,
      escrowBalanceWei: "7000000000000000",
      milestones: delivered.milestones.map((m) => (m.id === 1 ? { ...m, paid: true } : m)),
      transactions: [
        { action: "claimMilestone", milestoneId: 1, hash: "0xabc", blockNumber: 9, status: 1 },
      ],
    };
    vi.spyOn(api, "confirmOperation").mockResolvedValue({
      project: claimed,
      report: { outcome: "confirmed", summary: "Milestone 1 was claimed." },
    });
    render(<Panel initial={delivered} />);
    expect(screen.queryByRole("button", { name: /claim/ })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Test chain only: skip to the end of the review" }),
    );
    const claim = await screen.findByRole("button", { name: "Provider: claim 0.003 test ETH" });
    expect(advance).toHaveBeenCalledWith("p1", 7 * DAY + 5);
    expect(screen.getByText("Review ended · the provider can claim the payment")).toBeTruthy();
    fireEvent.click(claim);
    await screen.findByRole("button", { name: "Confirm claim and payment" });
    expect(screen.getByLabelText("Payment confirmation details")).toHaveTextContent(
      "Claims milestone #1 “Logo”: its review ended with no change request. This cannot be undone.",
    );
    expect(screen.getByLabelText("Payment confirmation details")).toHaveTextContent(
      "After it, 1 more milestone (0.007 test ETH) stays in escrow",
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm claim and payment" }));
    await screen.findByText("Paid after the review period");
    expect(screen.getByTestId("review-actions")).toHaveTextContent("2. Guidelines");
  });

  it("keeps the v1 buttons for an agreement without a review period", () => {
    const { review: _review, reviewPeriodSeconds: _p, changeRequestLimit: _l, ...v1 } = base;
    render(<Panel initial={v1} />);
    expect(screen.queryByTestId("review-actions")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Accept milestone 1 and pay 0.003 test ETH" }),
    ).toBeTruthy();
  });
});

describe("review period disclosure", () => {
  const spec = (review: Partial<DraftSpec>): DraftSpec => ({
    schemaVersion: 1,
    projectId: "test",
    specVersion: 1,
    name: "Demo",
    clientWallet: null,
    developerWallet: null,
    approvalRole: "client",
    deadline: null,
    refundPolicy: "none",
    totalAmountWei: "10000000000000000",
    milestones: [{ id: 1, title: "Logo", amountWei: "10000000000000000" }],
    ...review,
  });
  it("explains the review, the change limit and what can still stay locked", () => {
    render(<PaymentRules spec={spec({ reviewPeriodSeconds: 10 * DAY, changeRequestLimit: 2 })} />);
    expect(screen.getByText(/When the provider marks a milestone delivered/)).toHaveTextContent(
      "the client has 10 days to approve it or ask for changes (up to 2 times). If the client does neither, the provider can claim that payment.",
    );
    expect(screen.getByText(/never marks a milestone delivered/)).toBeTruthy();
    expect(screen.queryByText(/automatic approval/)).toBeNull();
  });
  it("warns that unlimited change requests can hold the money", () => {
    render(<PaymentRules spec={spec({ reviewPeriodSeconds: 14 * DAY, changeRequestLimit: 0 })} />);
    expect(screen.getByText(/keeps asking for changes/)).toBeTruthy();
  });
  it("words durations plainly", () => {
    expect(durationText(14 * DAY)).toBe("14 days");
    expect(durationText(DAY + 6 * 3600)).toBe("1 day 6 hours");
    expect(durationText(3 * 3600)).toBe("3 hours");
    expect(durationText(5 * 60 + 30)).toBe("5 minutes");
    expect(durationText(20)).toBe("less than a minute");
  });
});
