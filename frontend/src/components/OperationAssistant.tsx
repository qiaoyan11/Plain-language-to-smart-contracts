import { useEffect, useRef, useState } from "react";
import {
  api,
  formatWei,
  type OperationPlan,
  type OperationReport,
  type Project,
} from "@/api/client";
import type { ExchangeRate, MilestoneAction } from "@/api/types";
import { amountText, inCurrency } from "@/lib/money";
import { shortAddress } from "@/lib/address";
import { changesLeft, durationText, reviewPeriod, reviewStage, useChainNow } from "@/lib/review";

/** Button wording for each confirmation, so the user sees exactly what will be recorded. */
const CONFIRM_LABEL: Record<string, string> = {
  deposit: "Confirm deposit",
  acceptMilestone: "Confirm acceptance and payment",
  claimMilestone: "Confirm claim and payment",
  submitDelivery: "Confirm delivery",
  requestChanges: "Confirm change request",
};

/** Payment buttons and plain-language operations (Agent 3). The backend keeps the intent; this panel only shows it and asks for approval. */
export function OperationAssistant({
  project,
  disabled,
  onProject,
  refreshProject,
  quickActions = false,
  naturalLanguageEnabled = true,
  rate,
}: {
  project: Project;
  disabled: boolean;
  /** The agreement's original currency, to show "≈ 500 USD" in payment previews. */
  rate?: ExchangeRate | undefined;
  onProject: (project: Project) => void | Promise<void>;
  refreshProject?: () => Promise<void>;
  quickActions?: boolean;
  naturalLanguageEnabled?: boolean;
}) {
  const unit = "test ETH";
  // Buttons name the amount the way it was agreed: "Deposit 800 USD", or test ETH without a rate.
  const short = (wei: string) =>
    rate ? `${inCurrency(wei, rate)} ${rate.currency}` : `${formatWei(wei)} ${unit}`;
  const active = useRef(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"plan" | "confirm" | "clock" | null>(null);
  const [plan, setPlan] = useState<OperationPlan | null>(null);
  const [report, setReport] = useState<OperationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"language" | "button">("language");
  const [refreshFailed, setRefreshFailed] = useState(false);
  const nextMilestone = project.milestones.find((m) => !m.paid);
  const now = useChainNow(project);
  const stage = nextMilestone ? reviewStage(project, nextMilestone, now) : null;
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
        : !project.funded ||
          !milestone ||
          milestone.paid ||
          (plan.intent.action === "submitDelivery" && Boolean(milestone.deliveredAt)) ||
          (["requestChanges", "claimMilestone"].includes(plan.intent.action) &&
            !milestone.deliveredAt))
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
      setError(
        e instanceof TypeError
          ? "The payment preview could not be loaded. Prepare a new preview after reconnecting."
          : (e as Error).message,
      );
      await refresh();
    } finally {
      active.current = false;
      setBusy(null);
    }
  };
  const known = (action: MilestoneAction) =>
    nextMilestone &&
    prepare("button", () =>
      api.planKnownOperation(project.id, { action, milestoneId: nextMilestone.id }),
    );
  // Test network only: jump to the end of the current review so a claim can be shown.
  const skipReview = async () => {
    if (!stage || stage.kind !== "inReview" || active.current || disabled) return;
    active.current = true;
    setBusy("clock");
    setPlan(null);
    setReport(null);
    setError(null);
    try {
      await onProject(await api.advanceClock(project.id, stage.remaining + 5));
    } catch (e) {
      setError((e as Error).message);
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
      setError(
        e instanceof TypeError
          ? "The payment response did not arrive. Check the balance and transaction history before trying another payment."
          : message.includes("Plan not found")
            ? "This payment preview has expired. Review the current balance, then prepare and confirm a new preview."
            : message,
      );
      // The transaction may have completed before the response was lost. Read state; never resend it.
      await refresh();
    } finally {
      setPlan(null);
      active.current = false;
      setBusy(null);
    }
  };

  // Milestones still unpaid after the one in the current preview.
  const later = project.milestones.filter((m) => !m.paid && m.id !== plan?.intent?.milestoneId);
  const review = plan && (
    <div className="mt-4 border-t border-border pt-4 text-sm">
      {/* A payment ready to send is described by the box below; other answers are the text. */}
      {!(executable && plan.payment) && (
        <p className="whitespace-pre-wrap break-words">{plan.question ?? plan.summary}</p>
      )}
      {executable && plan.payment && (
        <div
          className="space-y-2 rounded-md bg-muted p-3"
          aria-label="Payment confirmation details"
        >
          <p>
            Amount: <strong>{amountText(plan.payment.amountWei, rate)}</strong>
          </p>
          <p className="break-all" title={plan.payment.to}>
            {plan.intent?.action === "deposit" ? "Into the escrow" : "To the provider"}:{" "}
            {shortAddress(plan.payment.to)}
          </p>
          <p>
            {plan.intent?.action === "deposit"
              ? project.review
                ? "It stays in escrow until each payment is approved or claimed after its review. This cannot be undone."
                : "It stays in escrow until the client approves each payment. This cannot be undone."
              : plan.intent?.action === "claimMilestone"
                ? `Claims milestone #${plan.intent.milestoneId} “${plan.payment.milestoneTitle}”: its review ended without an answer from the client. This cannot be undone.`
                : `Accepts milestone #${plan.intent?.milestoneId} “${plan.payment.milestoneTitle}”. This cannot be undone.`}
          </p>
          {plan.intent?.action !== "deposit" && later.length > 0 && (
            <p className="text-muted-foreground">
              {`After it, ${later.length} more milestone${later.length === 1 ? "" : "s"} (${amountText(
                later.reduce((sum, m) => sum + BigInt(m.amountWei), 0n).toString(),
                rate,
              )}) ${later.length === 1 ? "stays" : "stay"} in escrow until ${project.review ? "approved or claimed" : "approved"}.`}
            </p>
          )}
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
              ? "Recording on the test network…"
              : source === "button"
                ? (CONFIRM_LABEL[plan.intent?.action ?? ""] ?? "Confirm and send")
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
            You review each step before anything is sent.
          </p>
          {!project.funded ? (
            <button
              className="btn btn-primary mt-3"
              disabled={disabled || busy !== null || !project.contractAddress}
              onClick={() =>
                prepare("button", () => api.planKnownOperation(project.id, { action: "deposit" }))
              }
            >
              Deposit {short(project.totalAmountWei)}
            </button>
          ) : nextMilestone && stage ? (
            <ReviewActions
              stage={stage}
              title={`${nextMilestone.id}. ${nextMilestone.title}`}
              amount={short(nextMilestone.amountWei)}
              period={durationText(reviewPeriod(project) ?? 0)}
              left={changesLeft(project, nextMilestone)}
              requested={nextMilestone.changeRequests ?? 0}
              disabled={disabled || busy !== null || !project.contractAddress}
              skipping={busy === "clock"}
              onAction={known}
              onSkip={() => void skipReview()}
            />
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
                {`Accept milestone ${nextMilestone.id} and pay ${short(nextMilestone.amountWei)}`}
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
            Or just say what happened. You still confirm before anything is sent.
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
            {busy === "plan" && source === "language" ? "Asking the assistant…" : "Ask"}
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

/**
 * v2 buttons for the next milestone. One person may play both sides on the test network, so each button
 * says whose step it is: the provider delivers and claims, the client approves or asks for changes.
 */
function ReviewActions({
  stage,
  title,
  amount,
  period,
  left,
  requested,
  disabled,
  skipping,
  onAction,
  onSkip,
}: {
  stage: NonNullable<ReturnType<typeof reviewStage>>;
  title: string;
  amount: string;
  period: string;
  left: number | null;
  /** Change requests already made for this milestone. */
  requested: number;
  disabled: boolean;
  skipping: boolean;
  onAction: (action: MilestoneAction) => void;
  onSkip: () => void;
}) {
  const status = {
    notDelivered: requested
      ? `Changes requested. Once the provider delivers again, the client has ${period} to approve it or ask for changes.`
      : `Not delivered yet. Once the provider marks it delivered, the client has ${period} to approve it or ask for changes.`,
    inReview: `Delivered. The client has ${stage.kind === "inReview" ? durationText(stage.remaining) : ""} left to approve it or ask for changes. With no answer by then, the provider can claim the payment.`,
    reviewOver:
      "The review ended without an answer from the client. The provider can now claim the payment.",
  }[stage.kind];
  const button = (action: MilestoneAction, label: string, primary = false) => (
    <button
      key={action}
      className={`btn ${primary ? "btn-primary" : "btn-outline"}`}
      disabled={disabled || (action === "requestChanges" && left === 0)}
      onClick={() => onAction(action)}
    >
      {label}
    </button>
  );
  return (
    <div className="mt-3" data-testid="review-actions">
      <p className="text-sm">
        <strong className="break-words">{title}</strong> · {amount}
      </p>
      <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">
        {status}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {stage.kind === "notDelivered" && [
          button("submitDelivery", "Provider: mark as delivered", true),
          button("acceptMilestone", `Client: approve and pay ${amount}`),
        ]}
        {stage.kind === "inReview" && [
          button("acceptMilestone", `Client: approve and pay ${amount}`, true),
          button(
            "requestChanges",
            left === null ? "Client: ask for changes" : `Client: ask for changes (${left} left)`,
          ),
        ]}
        {stage.kind === "reviewOver" && button("claimMilestone", `Provider: claim ${amount}`, true)}
      </div>
      {stage.kind === "inReview" && left === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          No change requests left for this milestone under the agreement.
        </p>
      )}
      {stage.kind === "inReview" && (
        <button
          className="mt-3 text-xs underline underline-offset-2 disabled:opacity-50"
          disabled={disabled}
          onClick={onSkip}
        >
          {skipping
            ? "Moving the test network clock…"
            : "Test network: skip to the end of the review"}
        </button>
      )}
    </div>
  );
}
