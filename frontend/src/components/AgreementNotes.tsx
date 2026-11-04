import type { Workspace } from "@/api/workspace";
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
export function PaymentRules() {
  return (
    <section className="my-7 border-y border-border py-5">
      <h2 className="mb-3">What this contract will enforce</h2>
      <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
        <li>The client deposits the full amount first.</li>
        <li>Only the client approves payments, in milestone order, once each.</li>
        <li>The client judges delivery quality. The program cannot inspect the work.</li>
        <li>
          Refunds, deadlines, automatic acceptance and maintenance guarantees are not implemented.
        </li>
      </ul>
    </section>
  );
}
export function ScopeAcknowledgement({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
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
        I agree to proceed with only the payment rules shown here. Other terms need human review;
        unsupported rules will not be implemented in this contract.
      </span>
    </label>
  );
}
