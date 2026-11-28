import type { Workspace } from "@/api/workspace";
import type { DraftSpec, ExchangeRate } from "@/api/types";
import { formatWei } from "@/api/client";
import { inCurrency } from "@/lib/money";
import { durationText } from "@/lib/review";
export function AgreementNotes({ workspace }: { workspace: Workspace | null }) {
  return (
    <details className="agreement-summary">
      <summary>Original description & additional terms</summary>
      <div className="mt-4 space-y-4 text-sm leading-relaxed">
        {workspace?.messages
          .filter((m) => m.role === "user")
          .map((m, i) => (
            <p key={i} className="whitespace-pre-wrap break-words">
              {m.content}
            </p>
          ))}
        {workspace?.notes && <p className="whitespace-pre-wrap break-words">{workspace.notes}</p>}
        {!workspace && (
          <p>
            Original notes are unavailable in this tab. Only the payment fields below were sent to
            the backend.
          </p>
        )}
        <p className="text-muted-foreground">
          This text is kept in this browser tab for human review. It is not used to generate the
          contract or enforced on-chain. Copy it separately if you need a permanent record.
        </p>
      </div>
    </details>
  );
}
/**
 * What the contract will do, in three plain steps with the real amounts, so the user knows what
 * to expect before it is written. Shown on the review page right above the confirmation.
 */
export function PaymentRules({
  spec,
  rate,
}: {
  spec?: DraftSpec | undefined;
  rate?: ExchangeRate | undefined;
}) {
  const money = (wei: string) =>
    rate
      ? `${inCurrency(wei, rate)} ${rate.currency} (${formatWei(wei)} test ETH)`
      : `${formatWei(wei)} test ETH`;
  const milestones = spec?.milestones.filter((m) => m.amountWei) ?? [];
  const complete = Boolean(spec?.totalAmountWei) && milestones.length === spec?.milestones.length;
  const period = spec?.reviewPeriodSeconds ? durationText(spec.reviewPeriodSeconds) : null;
  const limit = spec?.changeRequestLimit ?? 0;
  const changes =
    limit === 0
      ? "ask for changes"
      : `ask for changes (up to ${limit} time${limit === 1 ? "" : "s"})`;
  return (
    <section className="my-7 border-y border-border py-5">
      <h2 className="mb-3">How the contract will work</h2>
      <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed">
        <li>
          {complete
            ? `The client deposits the full ${money(spec!.totalAmountWei!)} into the contract before the first payment.`
            : "The client deposits the full price into the contract before the first payment."}
        </li>
        {period && (
          <li>
            {`When the provider marks a milestone delivered, the client has ${period} to approve it or ${changes}. If the client does neither, the provider can claim that payment.`}
          </li>
        )}
        <li>
          {complete && milestones.length === 1
            ? period
              ? `When “${milestones[0]!.title}” is approved or claimed, the whole amount goes to the provider.`
              : `When the client approves “${milestones[0]!.title}”, the whole amount goes to the provider.`
            : period
              ? "Each payment goes straight to the provider, one at a time and in this order:"
              : "Each time the client approves a milestone, its payment goes straight to the provider, one at a time and in this order:"}
          {complete && milestones.length > 1 && (
            <ul className="mt-1 list-disc pl-5">
              {milestones.map((m) => (
                <li key={m.id}>{`“${m.title}”: ${money(m.amountWei!)}`}</li>
              ))}
            </ul>
          )}
        </li>
        <li>
          {period
            ? "That is all it does. It has no refunds, deadlines for the work or penalties; your written agreement covers those."
            : "That is all it does. It has no refunds, deadlines, penalties or automatic approval; your written agreement covers those."}
        </li>
      </ol>
      <p className="mt-3 text-sm font-medium leading-relaxed">
        {!period
          ? "If the client never approves a payment, that money can remain locked in the contract forever, even if both sides agree to release it."
          : limit === 0
            ? "If the provider never delivers, or the client keeps asking for changes, that money stays locked in the contract."
            : "If the provider never marks a milestone delivered, its money stays locked in the contract."}
      </p>
    </section>
  );
}
export function ScopeAcknowledgement({
  checked,
  onChange,
  notEnforced = false,
  review = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  notEnforced?: boolean;
  /** v2: an unanswered delivery can be claimed, so the warning is different. */
  review?: boolean;
}) {
  return (
    <label className="flex items-start gap-3 text-sm leading-relaxed">
      <input
        type="checkbox"
        className="mt-1 shrink-0"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {review
          ? "I agree to these payments. I understand the deposit cannot be refunded, and a delivery the client does not answer during the review can be claimed by the provider."
          : "I agree to these payments. I understand the deposit cannot be refunded, and money the client never approves stays locked."}
        {notEnforced && " The conditions the contract does not enforce are not part of them."}
      </span>
    </label>
  );
}
