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
          This text is kept in this browser tab for human review. It is not sent to Agent 2 or
          enforced on-chain. Copy it separately if you need a permanent record.
        </p>
      </div>
    </details>
  );
}
export function PaymentRules({ spec, zh = false }: { spec?: DraftSpec | undefined; zh?: boolean }) {
  const first = spec?.milestones[0]?.amountWei;
  const remaining = spec?.totalAmountWei && first && spec.milestones.length > 1
    ? BigInt(spec.totalAmountWei) - BigInt(first)
    : null;
  return (
    <section className="my-7 border-y border-border py-5">
      <h2 className="mb-3">{zh ? "存款后，谁能动这笔钱？" : "What happens to your deposit?"}</h2>
      <p className="text-sm leading-relaxed">
        {zh ? "客户先存入全款，自行验收交付物。只有客户能按顺序批准各期付款，每期只能付一次。"
          : "The client deposits the full price, checks each delivery, and approves each payment once, in order."}
      </p>
      {remaining !== null && remaining > 0n && first && (
        <p className="mt-3 text-sm leading-relaxed">
          {zh ? `按这份协议，第一期支付 ${formatWei(first)} 测试 ETH 后，合约中还剩 ${formatWei(remaining.toString())} 测试 ETH。`
            : `After the first payment of ${formatWei(first)} test ETH, this escrow will still hold ${formatWei(remaining.toString())} test ETH.`}
        </p>
      )}
      <p className="mt-3 text-sm font-medium leading-relaxed">
        {zh ? "如果客户一直不再批准付款，余款可能永久锁在合约里。客户无法退款，服务方也无法自行领取，即使双方同意也没有退款入口。"
          : "If the client never approves another payment, unpaid funds can remain locked forever. The client cannot withdraw them and the provider cannot claim them. Even mutual agreement cannot trigger a refund."}
      </p>
    </section>
  );
}
export function ScopeAcknowledgement({
  checked,
  onChange,
  zh = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  zh?: boolean;
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
        {zh ? "我确认以上付款规则，并理解存款后无法退款，未批准支付的余款可能永久锁定。"
          : "I confirm these payment rules and understand that deposits cannot be refunded and unpaid funds may remain locked forever."}
      </span>
    </label>
  );
}
