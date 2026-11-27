import type { Workspace } from "@/api/workspace";
import type { DraftSpec } from "@/api/types";
import { formatWei } from "@/api/client";
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
export function PaymentRules({ spec }: { spec?: DraftSpec | undefined }) {
  const first = spec?.milestones[0]?.amountWei;
  const remaining =
    spec?.totalAmountWei && first && spec.milestones.length > 1
      ? BigInt(spec.totalAmountWei) - BigInt(first)
      : null;
  return (
    <section className="my-7 border-y border-border py-5">
      <h2 className="mb-3">What happens to your deposit?</h2>
      <p className="text-sm leading-relaxed">
        The client deposits the full price, checks each delivery, and approves each payment once, in
        order.
      </p>
      {remaining !== null && remaining > 0n && first && (
        <p className="mt-3 text-sm leading-relaxed">
          {`After the first payment of ${formatWei(first)} test ETH, this escrow will still hold ${formatWei(remaining.toString())} test ETH.`}
        </p>
      )}
      <p className="mt-3 text-sm font-medium leading-relaxed">
        If the client never approves another payment, unpaid funds can remain locked forever. The
        client cannot withdraw them and the provider cannot claim them. Even mutual agreement cannot
        trigger a refund.
      </p>
    </section>
  );
}
export function ScopeAcknowledgement({
  checked,
  onChange,
  notEnforced = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  notEnforced?: boolean;
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
        I confirm these payment rules and understand that deposits cannot be refunded and unpaid
        funds may remain locked forever.
        {notEnforced &&
          " The conditions listed under “Not enforced by the contract” are not part of these rules."}
      </span>
    </label>
  );
}
