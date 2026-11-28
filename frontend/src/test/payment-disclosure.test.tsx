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
    expect(screen.getByText(/deposits the full/)).toHaveTextContent(
      "The client deposits the full 0.010000000000000001 test ETH into the contract",
    );
    expect(screen.getByText(/“Handover”/)).toHaveTextContent(
      "“Handover”: 0.001000000000000001 test ETH",
    );
    expect(screen.getByText(/If the client never approves a payment/)).toHaveTextContent(
      "can remain locked in the contract forever",
    );
  });
  it("states amounts in the agreed currency first and names a single milestone", () => {
    const spec: DraftSpec = {
      schemaVersion: 1,
      projectId: "test",
      specVersion: 1,
      name: "Logo",
      clientWallet: null,
      developerWallet: null,
      approvalRole: "client",
      deadline: null,
      refundPolicy: "none",
      totalAmountWei: "299490000000000000",
      milestones: [{ id: 1, title: "Final logo files", amountWei: "299490000000000000" }],
    };
    const rate = {
      currency: "USD",
      unitsPerEth: "1669.5",
      source: "live" as const,
      asOf: "2026-11-27T22:00:00Z",
      provider: "CoinGecko",
    };
    render(<PaymentRules spec={spec} rate={rate} />);
    expect(screen.getByText(/deposits the full/)).toHaveTextContent(
      "deposits the full 500 USD (0.29949 test ETH)",
    );
    expect(screen.getByText(/the whole amount goes to the provider/)).toHaveTextContent(
      "When the client approves “Final logo files”, the whole amount goes to the provider.",
    );
  });
});
