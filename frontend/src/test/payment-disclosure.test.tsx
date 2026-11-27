import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DraftSpec } from "@/api/types";
import { PaymentRules } from "@/components/AgreementNotes";

describe("payment disclosure", () => {
  it("uses the agreed amounts for all remaining milestones, down to the last wei", () => {
    const spec: DraftSpec = {
      schemaVersion: 1,
      projectId: "test",
      specVersion: 1,
      name: "Demo",
      clientWallet: null,
      developerWallet: null,
      approvalRole: "client",
      deadline: null,
      refundPolicy: "none",
      totalAmountWei: "10000000000000001",
      milestones: [
        { id: 1, title: "Homepage", amountWei: "3000000000000000" },
        { id: 2, title: "Checkout", amountWei: "6000000000000000" },
        { id: 3, title: "Handover", amountWei: "1000000000000001" },
      ],
    };
    render(<PaymentRules spec={spec} />);
    expect(screen.getByText(/After the first payment/)).toHaveTextContent(
      "0.007000000000000001 test ETH",
    );
    expect(screen.getByText(/If the client never approves another payment/)).toHaveTextContent(
      "can remain locked forever",
    );
  });
});
