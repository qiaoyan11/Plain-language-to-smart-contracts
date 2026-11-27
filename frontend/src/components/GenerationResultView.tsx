import type { ReactNode } from "react";
import type { GenerationRun } from "@/api/types";
const labels = {
  compilation: "Compilation",
  staticAnalysis: "Static analysis",
  clauseTests: "Payment-rule tests",
};
/** "Started 2 minutes ago. " while a run is in progress; the page polls, so this stays current. */
function elapsed(createdAt: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "Started less than a minute ago. ";
  const minutes = Math.floor(seconds / 60);
  return `Started ${minutes} minute${minutes === 1 ? "" : "s"} ago. `;
}
/** "24/24" from the clause-test report, when the validator states it. */
function clauseSummary(
  report: NonNullable<NonNullable<GenerationRun["result"]>["validationReport"]>,
) {
  const clauses = report.checks.find((check) => check.name === "clauseTests");
  for (const finding of clauses?.findings ?? []) {
    const match = /(\d+)\/(\d+)/.exec(finding.message);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}
/** Passed checks stay one click away; failures stay open so the reason is visible. */
function Technical({
  open,
  title,
  children,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
}) {
  if (open) return <>{children}</>;
  return (
    <details className="mt-4">
      <summary>Technical details: {title.toLowerCase()}</summary>
      {children}
    </details>
  );
}
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
  // The model stopped before returning any source, so there was nothing to check.
  const noContract =
    !obsolete &&
    run.status === "completed" &&
    result?.status === "failed" &&
    !result.sourceBundle &&
    result.attempts.length === 0;
  const title = obsolete
    ? "These results are out of date"
    : run.status === "running"
      ? "Generating and checking your contract"
      : run.status === "error"
        ? "Generation could not complete"
        : passed
          ? "Automatic checks passed"
          : noContract
            ? "The AI model did not return a contract"
            : result?.status === "toolError"
              ? "A tool could not finish"
              : "Contract checks did not pass";
  return (
    <section aria-live="polite" className="mt-8 border-t border-border pt-7">
      <h2>{title}</h2>
      {run.status === "running" && (
        <p className="mt-3 text-sm text-muted-foreground">
          {elapsed(run.createdAt)}This usually takes a few minutes. You can refresh or leave this
          page without restarting it; results appear here when the checks finish.
        </p>
      )}
      {obsolete && (
        <p className="mt-3 text-sm text-muted-foreground">
          Review and confirm the current agreement before generating again. This result does not
          apply to it.
        </p>
      )}
      {run.error && <p className="mt-3 text-sm text-destructive">{run.error.message}</p>}
      {noContract && (
        <p className="mt-3 text-sm leading-relaxed">
          The model's reply ended before it contained a complete contract, so no checks ran and
          nothing can be deployed. This is usually temporary. Start another generation to try again;
          your confirmed rules stay the same.
        </p>
      )}
      {!obsolete && !noContract && run.status === "completed" && !passed && report && (
        <p className="mt-3 text-sm leading-relaxed">
          Accord never deploys a contract that fails a check. The failing checks are listed below;
          start another generation to try again with the same confirmed rules.
        </p>
      )}
      {passed && report && (
        <p className="mt-3 text-sm leading-relaxed">
          {`The contract compiles, static analysis found no high- or medium-risk issues${clauseSummary(report) ? `, and ${clauseSummary(report)} payment-rule tests passed` : ", and the payment-rule tests passed"}. Open the technical details to see each check, the repair attempts and the Solidity source.`}
        </p>
      )}
      {!obsolete && report && (
        <Technical open={!passed} title="Checks">
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
        </Technical>
      )}
      {!obsolete && result && result.attempts.length > 0 && (
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
          Production use requires a separate security review.
        </p>
      )}
    </section>
  );
}
