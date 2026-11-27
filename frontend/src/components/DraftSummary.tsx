import { formatWei } from "@/api/client";
import type { ClarifyResult, DraftSession } from "@/api/types";
import { approximately, rateText } from "@/lib/money";
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

export function DraftSummary({
  result,
  compactIssues = false,
  primaryQuestionField,
  settledTerms = [],
}: {
  result: ClarifyResult | null;
  compactIssues?: boolean;
  primaryQuestionField?: string | undefined;
  settledTerms?: string[] | undefined;
}) {
  if (!result)
    return (
      <p className="text-sm text-muted-foreground">
        Your payment summary will appear here after you send a description.
      </p>
    );
  const spec = result.draftSpec;
  const rates = result.exchangeRates ?? [];
  const rate = rates.length === 1 ? rates[0] : undefined;
  const primaryIndex = result.questions.findIndex(
    (question) => question.field === primaryQuestionField,
  );
  const questions = compactIssues
    ? result.questions.filter((_, index) => index !== primaryIndex)
    : result.questions;
  const issues = (
    <>
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
      {questions.length > 0 && (
        <section aria-live={compactIssues ? "off" : "polite"}>
          <h2>Still to clarify</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
            {questions.map((question, i) => (
              <li key={i} className="whitespace-pre-wrap break-words">
                {question.question}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
  const issueCount = questions.length + result.unsupportedTerms.length;
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
              : `${formatWei(spec.totalAmountWei)} test ETH${approximately(spec.totalAmountWei, rate)}`
          }
        />
        {spec.milestones.map((m) => (
          <Row
            stacked
            key={m.id}
            label={`${m.id}. ${m.title}`}
            value={
              m.amountWei === null
                ? "Amount needed"
                : `${formatWei(m.amountWei)} test ETH${approximately(m.amountWei, rate)}`
            }
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
          label="Provider · receives payments"
          value={spec.developerWallet || "Address needed"}
          mono
        />
        {rates.map((item) => (
          <p key={item.currency} className="mt-3 text-xs text-muted-foreground">
            {rateText(item)}
          </p>
        ))}
        <p className="mt-4 text-sm text-muted-foreground">
          The client deposits the total, then approves each milestone in order.
        </p>
      </div>
      {compactIssues
        ? issueCount > 0 && (
            <details className="border-t border-border pt-4">
              <summary className="cursor-pointer text-sm">
                {`Other items to resolve (${issueCount})`}
              </summary>
              <div className="mt-4 space-y-5">{issues}</div>
            </details>
          )
        : issues}
      <SeparateTerms terms={result.separateTerms || []} />
      <SettledTerms terms={settledTerms} />
    </div>
  );
}

/** Conditions from the user's agreement that came up and were moved out of the payment rules. */
export function SettledTerms({ terms }: { terms: string[] }) {
  if (!terms.length) return null;
  return (
    <section>
      <h2>Not enforced by the contract</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        These conditions from your agreement came up in the conversation and were moved out of the
        contract's payment rules. If they still apply, your written agreement governs them.
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
        {includeTerms && <SettledTerms terms={session.settledTerms || []} />}
      </div>
    </details>
  );
}
