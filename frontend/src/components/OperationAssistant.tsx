import { useState } from "react";
import { api, type OperationPlan, type OperationReport, type Project } from "@/api/client";

/** Plain-language operations (Agent 3). The backend keeps the intent; this panel only shows it and asks for approval. */
export function OperationAssistant({
  project,
  disabled,
  onProject,
}: {
  project: Project;
  disabled: boolean;
  onProject: (project: Project) => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"plan" | "confirm" | null>(null);
  const [plan, setPlan] = useState<OperationPlan | null>(null);
  const [report, setReport] = useState<OperationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const executable =
    plan?.status === "readyForConfirmation" && plan.intent && plan.intent.action !== "query";

  const ask = async () => {
    setBusy("plan");
    setPlan(null);
    setReport(null);
    setError(null);
    try {
      setPlan(await api.planOperation(project.id, message));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const confirm = async () => {
    if (!plan) return;
    setBusy("confirm");
    setError(null);
    try {
      const done = await api.confirmOperation(project.id, plan.planId);
      setReport(done.report);
      onProject(done.project);
      setMessage("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlan(null);
      setBusy(null);
    }
  };

  return (
    <div className="panel mt-4">
      <h2 className="font-bold">Ask in plain language</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Agent 3 can check the escrow, deposit funds, or accept a milestone. It only proposes an
        operation. Nothing is sent until you confirm.
      </p>
      <label className="field-label mt-4" htmlFor="operation-message">
        Your request (English or Chinese)
      </label>
      <textarea
        id="operation-message"
        className="field"
        rows={2}
        maxLength={2000}
        placeholder='For example: "Approve the first milestone"'
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <button
        className="btn btn-primary mt-3"
        disabled={disabled || busy !== null || !message.trim() || !project.contractAddress}
        onClick={ask}
      >
        {busy === "plan" ? "Asking Agent 3…" : "Ask"}
      </button>
      {!project.contractAddress && (
        <p className="mt-1 text-xs text-muted-foreground">Deploy the contract first</p>
      )}
      {plan && (
        <div className="mt-4 border-t border-border pt-4 text-sm">
          <p className="whitespace-pre-wrap break-words">{plan.question ?? plan.summary}</p>
          {executable && (
            <div className="mt-3 flex gap-3">
              <button
                className="btn btn-primary"
                disabled={disabled || busy !== null}
                onClick={confirm}
              >
                {busy === "confirm" ? "Waiting for confirmation…" : "Confirm and send"}
              </button>
              <button
                className="btn btn-outline"
                disabled={busy !== null}
                onClick={() => setPlan(null)}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
      {report && (
        <p
          className={`mt-4 whitespace-pre-wrap break-words text-sm ${report.outcome === "confirmed" ? "text-success" : "text-destructive"}`}
        >
          {report.summary}
        </p>
      )}
      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
    </div>
  );
}
