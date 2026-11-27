import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GenerationRun } from "@/api/types";
import { GenerationResultView } from "@/components/GenerationResultView";
import { progressText } from "@/lib/generationProgress";

const running: GenerationRun = {
  schemaVersion: 1,
  id: "run-1",
  projectId: "project-1",
  specVersion: 1,
  confirmationId: "confirmation-1",
  status: "running",
  createdAt: new Date().toISOString(),
  finishedAt: null,
  result: null,
  error: null,
  generatedDeploymentEnabled: false,
};
const at = (stage: "writing" | "checking" | "repairing" | "finishing", attempt = 1) => ({
  stage,
  attempt,
  maxAttempts: 4,
  failedChecks: stage === "repairing" ? (["staticAnalysis"] as const).slice() : [],
  at: "",
});

afterEach(cleanup);

describe("generation progress", () => {
  it("says what the run is doing at each stage", () => {
    expect(progressText(undefined)).toBe("Writing the contract with AI.");
    expect(progressText(at("checking"))).toMatch(/^Checking the contract: compiling it/);
    expect(progressText(at("repairing", 2))).toBe(
      "Not passed yet: static analysis. The AI is revising the contract and it will be checked again (attempt 2 of 4).",
    );
    expect(progressText(at("checking", 2))).toBe("Checking the revised contract (attempt 2 of 4).");
    expect(progressText(at("finishing", 2))).toBe(
      "All checks passed. Saving the checked contract.",
    );
  });
  it("shows the current stage while a run is in progress", () => {
    render(
      <GenerationResultView run={{ ...running, progress: at("checking") }} currentVersion={1} />,
    );
    expect(screen.getByTestId("generation-progress")).toHaveTextContent(
      "Checking the contract: compiling it, running static analysis and testing every payment rule.",
    );
  });
});
