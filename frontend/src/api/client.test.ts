import { describe, it, expect } from "vitest";
import { actionBlockReason, applyAction, type Project } from "./client";

const base: Project = {
  id: "x", name: "t", clientWallet: "", developerWallet: "", totalEth: 0.01,
  contractAddress: "0xabc", escrowBalance: 0, deposited: false,
  paid: { stage1: false, stage2: false }, createdAt: "",
};

describe("payment rules", () => {
  it("cannot pay before deposit", () => {
    expect(actionBlockReason(base, "stage1")).not.toBeNull();
  });
  it("stage2 requires stage1", () => {
    const d = applyAction(base, "deposit");
    expect(actionBlockReason(d, "stage2")).not.toBeNull();
    const s1 = applyAction(d, "stage1");
    expect(s1.escrowBalance).toBe(0.007);
    expect(applyAction(s1, "stage2").escrowBalance).toBe(0);
  });
  it("paid stage cannot pay again", () => {
    const s1 = applyAction(applyAction(base, "deposit"), "stage1");
    expect(actionBlockReason(s1, "stage1")).not.toBeNull();
  });
});
