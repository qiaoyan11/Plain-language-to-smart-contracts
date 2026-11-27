import { useEffect, useRef, useState } from "react";
import {
  api,
  formatWei,
  type OperationPlan,
  type OperationReport,
  type Project,
} from "@/api/client";

/** Plain-language operations (Agent 3). The backend keeps the intent; this panel only shows it and asks for approval. */
export function OperationAssistant({
  project,
  disabled,
  onProject,
  refreshProject,
  quickActions = false,
  naturalLanguageEnabled = true,
}: {
  project: Project;
  disabled: boolean;
  onProject: (project: Project) => void | Promise<void>;
  refreshProject?: () => Promise<void>;
  quickActions?: boolean;
  naturalLanguageEnabled?: boolean;
}) {
  const unit = "test ETH";
  const active = useRef(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"plan" | "confirm" | null>(null);
  const [plan, setPlan] = useState<OperationPlan | null>(null);
  const [report, setReport] = useState<OperationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"language" | "button">("language");
  const [refreshFailed, setRefreshFailed] = useState(false);
  const nextMilestone = project.milestones.find((m) => !m.paid);
  const executable =
    plan?.status === "readyForConfirmation" && plan.intent && plan.intent.action !== "query";

  useEffect(() => {
    if (!plan?.intent || plan.intent.action === "query") return;
    const milestone = project.milestones.find((m) => m.id === plan.intent!.milestoneId);
    if (
      plan.intent.projectId !== project.id ||
      plan.intent.contractAddress !== project.contractAddress ||
      (plan.intent.action === "deposit"
        ? project.funded
        : !project.funded || !milestone || milestone.paid)
    )
      setPlan(null);
  }, [project, plan]);

  const refresh = async () => {
    try {
      if (refreshProject) await refreshProject();
      else await onProject(await api.getProjectSnapshot(project.id));
    } catch {
      setRefreshFailed(true);
    }
  };
  const prepare = async (kind: "language" | "button", request: () => Promise<OperationPlan>) => {
    if (active.current || disabled || !project.contractAddress) return;
    active.current = true;
    setBusy("plan");
    setSource(kind);
    setPlan(null);
    setReport(null);
    setError(null);
    setRefreshFailed(false);
    try {
      setPlan(await request());
    } catch (e) {
      setError(e instanceof TypeError
        ? "The payment preview could not be loaded. Prepare a new preview after reconnecting."
        : (e as Error).message);
      await refresh();
    } finally {
      active.current = false;
      setBusy(null);
    }
  };
  const ask = () => {
    if (!naturalLanguageEnabled || !message.trim()) return;
    return prepare("language", () => api.planOperation(project.id, message));
  };
  const confirm = async () => {
    if (!plan || !executable || active.current || disabled) return;
    active.current = true;
    setBusy("confirm");
    setError(null);
    setRefreshFailed(false);
    try {
      const done = await api.confirmOperation(project.id, plan.planId);
      setReport(done.report);
      await onProject(done.project);
      setMessage("");
    } catch (e) {
      const message = (e as Error).message;
      setError(e instanceof TypeError
        ? "The payment response did not arrive. Check the balance and transaction history before trying another payment."
        : message.includes("Plan not found")
          ? "This payment preview has expired. Review the current balance, then prepare and confirm a new preview."
          : message);
      // The transaction may have completed before the response was lost. Read state; never resend it.
      await refresh();
    } finally {
      setPlan(null);
      active.current = false;
      setBusy(null);
    }
  };

  const review = plan && (
    <div className="mt-4 border-t border-border pt-4 text-sm">
      {(source === "language" || !executable) && (
        <p className="whitespace-pre-wrap break-words">{plan.question ?? plan.summary}</p>
      )}
      {executable && plan.payment && (
        <div
          className="space-y-2 rounded-md bg-muted p-3"
          aria-label="Payment confirmation details"
        >
          <p>
            Amount:{" "}
            <strong>
              {formatWei(plan.payment.amountWei)} {unit}
            </strong>
          </p>
          <p className="break-all">Recipient: {plan.payment.to}</p>
          {plan.intent?.action === "acceptMilestone" ? (
            <p>{`Confirming accepts milestone #${plan.intent?.milestoneId} "${plan.payment.milestoneTitle}" and releases its payment to the provider.`}</p>
          ) : (
            <p>
              Funds enter escrow. This version has no refund or timeout release; funds may remain
              locked if the client does not approve.
            </p>
          )}
          <p>Once confirmed, this transfer cannot be reversed.</p>
        </div>
      )}
      {executable && (
        <div className="mt-3 flex gap-3">
          <button
            className="btn btn-primary"
            disabled={disabled || busy !== null}
            onClick={confirm}
          >
            {busy === "confirm"
              ? "Waiting for confirmation…"
              : source === "button"
                ? plan.intent?.action === "deposit"
                  ? "Confirm deposit"
                  : "Confirm acceptance and payment"
                : "Confirm and send"}
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
  );

  return (
    <div className="panel mt-4">
      {quickActions && (
        <section aria-label="Payment actions">
          <h2 className="font-bold">Payment actions</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Review the payment before confirming. These buttons make no model request.
          </p>
          {!project.funded ? (
            <button
              className="btn btn-primary mt-3"
              disabled={disabled || busy !== null || !project.contractAddress}
              onClick={() =>
                prepare("button", () => api.planKnownOperation(project.id, { action: "deposit" }))
              }
            >
              Deposit {formatWei(project.totalAmountWei)} {unit}
            </button>
          ) : nextMilestone ? (
            <>
              <button
                className="btn btn-primary mt-3"
                disabled={disabled || busy !== null || !project.contractAddress}
                onClick={() =>
                  prepare("button", () =>
                    api.planKnownOperation(project.id, {
                      action: "acceptMilestone",
                      milestoneId: nextMilestone.id,
                    }),
                  )
                }
              >
                {`Accept milestone ${nextMilestone.id} and pay`}{" "}
                {formatWei(nextMilestone.amountWei)} {unit}
              </button>
              <p className="mt-2 text-sm">{nextMilestone.title}</p>
            </>
          ) : (
            <p className="mt-3 text-success">All milestones paid.</p>
          )}
          {source === "button" && review}
        </section>
      )}
      {naturalLanguageEnabled ? (
        <section className={quickActions ? "mt-6 border-t border-border pt-4" : ""}>
          <h2 className="font-bold">Ask in plain language</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Asking Agent 3 starts a model request. You can check the escrow, deposit test funds or
            accept a milestone. Deposits and payments each require your confirmation.
          </p>
          <label className="field-label mt-4" htmlFor="operation-message">
            Your request
          </label>
          <textarea
            id="operation-message"
            className="field"
            rows={2}
            maxLength={2000}
            placeholder='For example: "Approve the first milestone"'
            value={message}
            disabled={disabled || busy !== null}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button
            className="btn btn-primary mt-3"
            disabled={disabled || busy !== null || !message.trim() || !project.contractAddress}
            onClick={ask}
          >
            {busy === "plan" && source === "language" ? "Asking Agent 3…" : "Ask"}
          </button>
          {!project.contractAddress && (
            <p className="mt-1 text-xs text-muted-foreground">Deploy the contract first</p>
          )}
          {source === "language" && review}
        </section>
      ) : (
        <p className="mt-5 text-sm text-muted-foreground">
          Plain-language operations are disabled on this backend. The payment buttons remain
          available.
        </p>
      )}
      {report && (
        <p
          className={`mt-4 whitespace-pre-wrap break-words text-sm ${report.outcome === "confirmed" ? "text-success" : "text-destructive"}`}
        >
          {report.summary}
        </p>
      )}
      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
      {refreshFailed && (
        <p className="mt-2 text-sm text-destructive">
          Refresh the project status before trying another payment.
        </p>
      )}
    </div>
  );
}
