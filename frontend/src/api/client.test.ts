import { describe, it, expect } from "vitest";
import { actionBlockReason, applyAction, ethToWei, formatWei, totalWei, type Project } from "./client";
const base: Project = {
  schemaVersion: 2, id: "x", name: "t", clientWallet: "", developerWallet: "",
  totalAmountWei: "10000000000000001", contractAddress: "0xabc", escrowBalanceWei: "0", funded: false,
  milestones: [
    { id: 1, title: "First", amountWei: "3000000000000000", paid: false },
    { id: 2, title: "Second", amountWei: "7000000000000000", paid: false },
    { id: 3, title: "Final", amountWei: "1", paid: false },
  ], transactions: [], createdAt: "",
};
const pay = (milestoneId: number) => ({ action: "acceptMilestone" as const, milestoneId });
describe("parameterized payment rules", () => {
  it("requires deployment and funding", () => {
    expect(actionBlockReason(base, pay(1))).not.toBeNull();
    expect(actionBlockReason({ ...base, contractAddress: null }, { action: "deposit" })).not.toBeNull();
  });
  it("pays three stages in order without losing a one-wei balance", () => {
    const deposited = applyAction(base, { action: "deposit" });
    expect(actionBlockReason(deposited, pay(2))).not.toBeNull();
    const first = applyAction(deposited, pay(1));
    expect(first.escrowBalanceWei).toBe("7000000000000001");
    expect(actionBlockReason(first, pay(3))).not.toBeNull();
    const second = applyAction(first, pay(2));
    expect(second.escrowBalanceWei).toBe("1");
    expect(applyAction(second, pay(3)).escrowBalanceWei).toBe("0");
    expect(base.milestones.every(m => !m.paid)).toBe(true);
  });
  it("blocks duplicates and invalid IDs", () => {
    const deposited = applyAction(base, { action: "deposit" });
    expect(() => applyAction(deposited, { action: "deposit" })).toThrow();
    const first = applyAction(deposited, pay(1));
    expect(() => applyAction(first, pay(1))).toThrow();
    for (const id of [0, 4, 1.5]) expect(actionBlockReason(first, pay(id))).not.toBeNull();
  });
});
describe("exact amount conversion", () => {
  it("round-trips 18 decimals and sums without floats", () => {
    for (const text of ["0.000000000000000001", "0.123456789123456789", "1", "9999999.123456789123456789"]) {
      expect(formatWei(ethToWei(text))).toBe(text);
    }
    expect(totalWei(base.milestones)).toBe(base.totalAmountWei);
    expect(formatWei("0")).toBe("0");
  });
  it("rejects zero, negatives, exponent notation, excess decimals and overflow", () => {
    for (const text of ["", "0", "-1", "1e-3", "NaN", "0.0000000000000000001", "01", "1.", "9".repeat(79)]) {
      expect(() => ethToWei(text)).toThrow();
    }
  });
  it("validates stage count, titles, integer amounts and total overflow", () => {
    for (const terms of [[], Array(6).fill(base.milestones[0]), [{ title: "", amountWei: "1" }],
      [{ title: "x", amountWei: "0" }], [{ title: "x", amountWei: "1.2" }],
      [{ title: "x", amountWei: ((1n << 256n) - 1n).toString() }, { title: "y", amountWei: "1" }]]) {
      expect(() => totalWei(terms)).toThrow();
    }
  });
});
