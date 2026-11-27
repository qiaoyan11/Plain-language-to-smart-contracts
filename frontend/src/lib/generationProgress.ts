import type { GenerationProgress } from "@/api/types";

const failedLabels = {
  compilation: "compilation",
  staticAnalysis: "static analysis",
  clauseTests: "payment-rule tests",
};

/** What the run is doing now, in the user's terms. */
export function progressText(progress: GenerationProgress | undefined) {
  if (!progress) return "Writing the contract with AI.";
  const of = `attempt ${progress.attempt} of ${progress.maxAttempts}`;
  const failed = progress.failedChecks.map((name) => failedLabels[name]);
  switch (progress.stage) {
    case "writing":
      return "Writing the contract with AI.";
    case "checking":
      return progress.attempt === 1
        ? "Checking the contract: compiling it, running static analysis and testing every payment rule."
        : `Checking the revised contract (${of}).`;
    case "repairing":
      return `${failed.length ? `Not passed yet: ${failed.join(", ")}` : "A check did not pass"}. The AI is revising the contract and it will be checked again (${of}).`;
    case "finishing":
      return "All checks passed. Saving the checked contract.";
  }
}
