import { formatWei } from "@/api/client";
import type { ClarifyResult, DraftSession } from "@/api/types";
import { Row } from "./Shell";

export function draftReady(session: DraftSession | undefined) {
  return Boolean(
    session &&
    !session.busy &&
    !session.pendingMessage &&
    !session.lastError &&
    session.result?.status === "readyForConfirmation" &&
    session.result.questions.length === 0 &&
    session.result.unsupportedTerms.length === 0,
  );
}

export function DraftSummary({ result }: { result: ClarifyResult | null }) {
  if (!result)
    return (
      <p className="text-sm text-muted-foreground">
        Your payment summary will appear here after you send a description.
      </p>
    );
  const spec = result.draftSpec;
  return (
    <div className="space-y-5">
      <div>
        <h2>Payment summary</h2>
        <Row stacked label="Project" value={spec.name || "To be agreed"} />
        <Row
          stacked
          label="Total"
          value={
            spec.totalAmountWei === null
              ? "Amount needed"
              : `${formatWei(spec.totalAmountWei)} test ETH`
          }
        />
        {spec.milestones.map((m) => (
          <Row
            stacked
            key={m.id}
            label={`${m.id}. ${m.title}`}
            value={m.amountWei === null ? "Amount needed" : `${formatWei(m.amountWei)} test ETH`}
          />
        ))}
        <Row
          stacked
          label="Client · deposits and approves"
          value={spec.clientWallet || "Address needed"}
          mono
        />
        <Row
          stacked
          label="Developer · receives payments"
          value={spec.developerWallet || "Address needed"}
          mono
        />
        <p className="mt-4 text-sm text-muted-foreground">
          The client deposits the total, then approves each milestone in order.
        </p>
      </div>
      {result.unsupportedTerms.length > 0 && (
        <section>
          <h2>Terms the contract cannot enforce</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
            {result.unsupportedTerms.map((term, i) => (
              <li key={i} className="whitespace-pre-wrap break-words">
                {term}
              </li>
            ))}
          </ul>
        </section>
      )}
      {result.questions.length > 0 && (
        <section aria-live="polite">
          <h2>Still to clarify</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
            {result.questions.map((question, i) => (
              <li key={i} className="whitespace-pre-wrap break-words">
                {question.question}
              </li>
            ))}
          </ul>
        </section>
      )}
      <SeparateTerms terms={result.separateTerms || []} />
    </div>
  );
}

export function SeparateTerms({ terms }: { terms: string[] }) {
  if (!terms.length) return null;
  return (
    <section>
      <h2>Separate written terms</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Keep these in your written agreement. They require human review and are outside the
        contract's payment rules.
      </p>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
        {terms.map((term, i) => (
          <li key={i} className="whitespace-pre-wrap break-words">
            {term}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DraftSource({
  session,
  includeTerms = true,
}: {
  session: DraftSession;
  includeTerms?: boolean;
}) {
  return (
    <details className="agreement-summary mt-5">
      <summary>Original description &amp; additional terms</summary>
      <div className="mt-4 space-y-4 text-sm">
        {session.messages.map((message, i) => (
          <p key={i} className="whitespace-pre-wrap break-words">
            {message.content}
          </p>
        ))}
        {includeTerms && <SeparateTerms terms={session.result?.separateTerms || []} />}
      </div>
    </details>
  );
}
