import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatWei, type Project } from "@/api/client";
import type { ExchangeRate } from "@/api/types";
import { amountText } from "@/lib/money";
import { shortAddress } from "@/lib/address";
import { durationText, reviewStage, useChainNow } from "@/lib/review";

const UNIT = "test ETH";
type Transaction = Project["transactions"][number];

/** The confirmed receipt for one action, if the backend recorded one. */
function receiptFor(project: Project, action: string, milestoneId?: number) {
  return project.transactions.find(
    (tx) =>
      tx.action === action &&
      tx.status === 1 &&
      (milestoneId === undefined || tx.milestoneId === milestoneId),
  );
}

function transactionLabel(tx: Transaction) {
  if (tx.action === "deploy") return "Contract deployed";
  if (tx.action === "deposit") return "Deposit";
  if (tx.action === "acceptMilestone") return `Milestone ${tx.milestoneId} paid`;
  if (tx.action === "submitDelivery") return `Milestone ${tx.milestoneId} delivered`;
  if (tx.action === "requestChanges") return `Changes requested for milestone ${tx.milestoneId}`;
  if (tx.action === "claimMilestone") return `Milestone ${tx.milestoneId} claimed after review`;
  return tx.action;
}

function Receipt({ tx }: { tx: Transaction }) {
  return (
    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
      Receipt · block {tx.blockNumber} · {tx.hash}
    </p>
  );
}

function milestoneStatus(project: Project, milestone: Project["milestones"][number], now: number) {
  if (milestone.paid)
    return receiptFor(project, "claimMilestone", milestone.id)
      ? "Paid after the review period"
      : "Paid";
  if (!project.contractAddress) return "Not deployed yet";
  if (!project.funded) return "Waiting for the deposit";
  const next = project.milestones.find((m) => !m.paid);
  if (next?.id !== milestone.id) return `Waiting for milestone ${milestone.id - 1}`;
  const stage = reviewStage(project, milestone, now);
  const changes = milestone.changeRequests
    ? ` · ${milestone.changeRequests} change request${milestone.changeRequests === 1 ? "" : "s"} so far`
    : "";
  if (!stage) return "Next: waiting for the client's approval";
  if (stage.kind === "notDelivered") return `Next: waiting for the provider to deliver${changes}`;
  if (stage.kind === "inReview")
    return `Delivered · ${durationText(stage.remaining)} left to review${changes}`;
  return "Review ended · the provider can claim the payment";
}

/** Deposit and milestones as the chain reports them: amount, recipient, paid state and receipt. */
export function MilestoneLedger({
  project,
  className = "my-7",
  rate,
}: {
  project: Project;
  className?: string;
  /** The agreement's original currency, to show "≈ 500 USD" beside each amount. */
  rate?: ExchangeRate | undefined;
}) {
  const now = useChainNow(project);
  const deposit = receiptFor(project, "deposit");
  const paid = project.milestones.filter((m) => m.paid).length;
  return (
    <section aria-label="Payments" className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2>Payments</h2>
        <span className="text-sm text-muted-foreground">
          {paid} of {project.milestones.length} milestones paid
        </span>
      </div>
      <ol className="mt-3 border-t border-border">
        <li className="border-b border-border py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-medium">Deposit from the client</span>
            <span className="text-sm font-medium">{amountText(project.totalAmountWei, rate)}</span>
          </div>
          <p className="mt-1 text-sm">
            {project.funded
              ? "Funded"
              : project.contractAddress
                ? "Awaiting deposit"
                : "Not deployed yet"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground" title={project.clientWallet}>
            From the client, {shortAddress(project.clientWallet)}
          </p>
          {deposit && <Receipt tx={deposit} />}
        </li>
        {project.milestones.map((m) => {
          const receipt = m.paid
            ? (receiptFor(project, "acceptMilestone", m.id) ??
              receiptFor(project, "claimMilestone", m.id))
            : undefined;
          return (
            <li key={m.id} className="border-b border-border py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="break-words text-sm font-medium">
                  {m.id}. {m.title}
                </span>
                <span className="text-sm font-medium">{amountText(m.amountWei, rate)}</span>
              </div>
              <p className={`mt-1 text-sm ${m.paid ? "font-medium text-success" : ""}`}>
                {milestoneStatus(project, m, now)}
              </p>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                <span title={project.developerWallet}>
                  {m.paid ? "Paid to" : "Pays"} the provider,{" "}
                  {shortAddress(project.developerWallet)}
                </span>
              </p>
              {receipt && <Receipt tx={receipt} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function TransactionHistory({ project }: { project: Project }) {
  if (!project.transactions.length) return null;
  return (
    <details className="mt-4">
      <summary>All transactions ({project.transactions.length})</summary>
      <ol className="mt-2">
        {project.transactions.map((tx) => (
          <li key={tx.hash} className="border-b border-border py-3 text-sm">
            {transactionLabel(tx)} · block {tx.blockNumber}
            <span className="block break-all font-mono text-xs text-muted-foreground">
              {tx.hash}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** What these payments can and cannot do, folded beside the payment controls. */
export function PaymentLimits({ review = false }: { review?: boolean }) {
  return (
    <details
      className="mt-6 rounded-md border border-border p-4 text-sm leading-relaxed"
      aria-label="About these payments"
    >
      <summary className="cursor-pointer font-medium">About these payments</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
        <li>
          Payments run on a test network with test ETH. Two built-in test accounts sign for the
          client and the provider, so there is no wallet prompt and no real money.
        </li>
        <li>
          A confirmed deposit or payment is final. This version has no refund, cancellation or
          dispute resolution{review ? "" : ", and no deadlines"}.
        </li>
        <li>
          {review
            ? "The client approves each delivery or asks for changes during the review. If the client does neither, the provider can claim the payment."
            : "The client alone decides whether each delivery is acceptable."}
        </li>
      </ul>
    </details>
  );
}

/** Copy the current project address so the user can return to it later. */
export function ProjectLink() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const url = typeof window === "undefined" ? "" : window.location.href;
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="mt-4">
      <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
        Copy project link
      </Button>
      <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
        {state === "copied"
          ? "Link copied. Anyone with access to Accord can open this project with it."
          : state === "failed"
            ? "This browser blocked copying. Copy the link below instead."
            : ""}
      </p>
      {state === "failed" && (
        <input
          aria-label="Project link"
          readOnly
          className="field mt-2 font-mono text-xs"
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
    </div>
  );
}

/** Explains that refreshing only reads state. */
export function RefreshHelp() {
  return <p className="text-xs text-muted-foreground">Reloads the project. It sends nothing.</p>;
}
