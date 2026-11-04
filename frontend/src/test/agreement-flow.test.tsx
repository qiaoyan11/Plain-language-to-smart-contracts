import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => navigate,
}));
vi.mock("@/components/Shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
import { CreatePage } from "@/routes/index";
import { ConfirmPage } from "@/routes/confirm";
import { GenerationResultView } from "@/components/GenerationResultView";
import { api } from "@/api/client";
import { addMessage, emptyWorkspace, SAMPLE_MESSAGE } from "@/api/workspace";
import type { GenerationRun } from "@/api/types";
beforeEach(() => {
  sessionStorage.clear();
  navigate.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("conversation UI", () => {
  it("starts without wallets, accepts another message, and preserves it across remounts", () => {
    const page = render(<CreatePage />);
    expect(screen.queryByText("Client wallet · approves payments")).toBeNull();
    fireEvent.click(screen.getByText("Try a scripted example"));
    fireEvent.change(screen.getByLabelText("Describe your agreement or add a detail"), {
      target: { value: "Please hand over the source code." },
    });
    fireEvent.click(screen.getByText("Add to agreement"));
    expect(screen.getByText("Please hand over the source code.")).toBeTruthy();
    page.unmount();
    render(<CreatePage />);
    expect(screen.getByText("Please hand over the source code.")).toBeTruthy();
    expect(api.getWorkspace().messages.filter((m) => m.role === "user")).toHaveLength(2);
  });
  it("requires acknowledgement and rechecks it after editing payment details", async () => {
    const state = addMessage(emptyWorkspace(), SAMPLE_MESSAGE);
    state.draft.clientWallet = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    state.draft.developerWallet = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    api.saveWorkspace(state);
    const create = vi.spyOn(api, "createAgreement").mockRejectedValue(new Error("network offline"));
    render(<ConfirmPage />);
    fireEvent.click(screen.getByText("Confirm agreement"));
    expect(create).not.toHaveBeenCalled();
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Milestone 1 amount in ETH"), {
      target: { value: "0.004" },
    });
    expect(checkbox.checked).toBe(false);
    fireEvent.click(screen.getByText("Confirm agreement"));
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByText("Confirm agreement"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("network offline"));
    expect(create).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("honest generation results", () => {
  const run: GenerationRun = {
    schemaVersion: 1,
    id: "r",
    projectId: "p",
    specVersion: 1,
    confirmationId: "c",
    status: "completed",
    createdAt: "",
    finishedAt: "",
    result: { status: "failed", sourceBundle: null, validationReport: null, attempts: [] },
    error: null,
    generatedDeploymentEnabled: false,
  };
  it("completed transport with failed checks is not displayed as a pass", () => {
    render(<GenerationResultView run={run} currentVersion={1} />);
    expect(screen.getByText("Contract checks did not pass")).toBeTruthy();
    expect(screen.queryByText("Development checks passed")).toBeNull();
    expect(screen.queryByRole("button", { name: /deploy/i })).toBeNull();
  });
  it("discards results belonging to an older agreement version", () => {
    render(<GenerationResultView run={run} currentVersion={2} />);
    expect(screen.getByText("These results are out of date")).toBeTruthy();
    expect(screen.queryByText("Contract checks did not pass")).toBeNull();
  });
});
