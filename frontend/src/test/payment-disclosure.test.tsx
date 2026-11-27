import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DraftSpec } from "@/api/types";
import { PaymentRules } from "@/components/AgreementNotes";

describe("payment disclosure", () => {
  it("uses the agreed amounts for all remaining milestones, down to the last wei", () => {
    const spec: DraftSpec = {
      schemaVersion: 1, projectId: "test", specVersion: 1, name: "演示",
      clientWallet: null, developerWallet: null, approvalRole: "client",
      deadline: null, refundPolicy: "none", totalAmountWei: "10000000000000001",
      milestones: [
        { id: 1, title: "首页", amountWei: "3000000000000000" },
        { id: 2, title: "结算页", amountWei: "6000000000000000" },
        { id: 3, title: "交接", amountWei: "1000000000000001" },
      ],
    };
    render(<PaymentRules spec={spec} zh />);
    expect(screen.getByText(/第一期支付/)).toHaveTextContent("0.007000000000000001 测试 ETH");
    expect(screen.getByText(/如果客户一直不再批准付款/)).toHaveTextContent("可能永久锁在合约里");
  });
});
