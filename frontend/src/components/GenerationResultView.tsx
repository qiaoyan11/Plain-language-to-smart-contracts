import type { GenerationRun } from "@/api/types";
const labels = {
  compilation: "Compilation",
  staticAnalysis: "Static analysis",
  clauseTests: "Payment-rule tests",
};
export function GenerationResultView({
  run,
  currentVersion,
}: {
  run: GenerationRun;
  currentVersion: number;
}) {
  const obsolete = run.status === "obsolete" || run.specVersion !== currentVersion;
  const result = run.result,
    report = result?.validationReport;
  const passed =
    !obsolete &&
    run.status === "completed" &&
    result?.status === "validated" &&
    report?.status === "passed";
  const title = obsolete
    ? "These results are out of date"
    : run.status === "running"
      ? "Generating and checking your contract"
      : run.status === "error"
        ? "Generation could not complete"
        : passed
          ? "Development checks passed"
          : result?.status === "toolError"
            ? "A tool could not finish"
            : "Contract checks did not pass";
  return (
    <section aria-live="polite" className="mt-8 border-t border-border pt-7">
      <h2>{title}</h2>
      {run.status === "running" && (
        <p className="mt-3 text-sm text-muted-foreground">
          You can refresh this page without restarting the run. Detailed results appear when the
          worker finishes.
        </p>
      )}
      {obsolete && (
        <p className="mt-3 text-sm text-muted-foreground">
          Review and confirm the current agreement before generating again. This result does not
          apply to it.
        </p>
      )}
      {run.error && <p className="mt-3 text-sm text-destructive">{run.error.message}</p>}
      {!obsolete && report && (
        <div className="my-5 space-y-3">
          {report.checks.map((check) => (
            <div key={check.name} className="rounded border border-border p-4">
              <div className="flex flex-wrap justify-between gap-3 text-sm">
                <span>{labels[check.name]}</span>
                <strong
                  className={check.status === "passed" ? "text-primary" : "text-muted-foreground"}
                >
                  {check.status}
                </strong>
              </div>
              {check.findings.map((finding, i) => (
                <p
                  key={i}
                  className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground"
                >
                  {finding.severity}: {finding.message}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
      {!obsolete && result && (
        <details className="mt-5">
          <summary>Recorded attempts ({result.attempts.length})</summary>
          <p className="my-3 text-xs text-muted-foreground">
            The final report is shown above. Full reports for earlier attempts are stored on the
            backend.
          </p>
          {result.attempts.map((a) => (
            <div key={a.attempt} className="mb-4 break-all text-xs">
              <p className="font-medium">
                {a.attempt === 0 ? "Initial generation" : `Repair ${a.attempt}`}
              </p>
              <p className="mt-1 text-muted-foreground">Report: {a.reportId || "No report"}</p>
              {a.feedbackUsed.map((feedback, i) => (
                <p key={i} className="mt-1 whitespace-pre-wrap">
                  {feedback}
                </p>
              ))}
            </div>
          ))}
        </details>
      )}
      {!obsolete && result?.sourceBundle && (
        <details className="mt-5">
          <summary>Generated Solidity source</summary>
          {Object.entries(result.sourceBundle.sources).map(([name, source]) => (
            <div key={name} className="mt-4">
              <h3 className="mb-2 text-sm font-medium">{name}</h3>
              <pre className="max-h-96 overflow-auto rounded bg-muted p-4 text-xs">{source}</pre>
            </div>
          ))}
        </details>
      )}
      {passed && (
        <p className="mt-4 text-sm text-muted-foreground">
          These are development checks, not a production security audit. This contract has not been
          deployed.
        </p>
      )}
    </section>
  );
}
