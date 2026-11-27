import { formatWei } from "@/api/client";
import type { ClarifyResult, DraftSession } from "@/api/types";
import type { DraftLanguage } from "@/lib/draft-language";
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
  language = "en",
  compactIssues = false,
  primaryQuestionField,
}: {
  result: ClarifyResult | null;
  language?: DraftLanguage;
  compactIssues?: boolean;
  primaryQuestionField?: string | undefined;
}) {
  const zh = language === "zh";
  if (!result)
    return (
      <p className="text-sm text-muted-foreground">
        {zh
          ? "发送描述后，这里会显示付款摘要。"
          : "Your payment summary will appear here after you send a description."}
      </p>
    );
  const spec = result.draftSpec;
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
          <h2>{zh ? "合约无法执行的条款" : "Terms the contract cannot enforce"}</h2>
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
          <h2>{zh ? "待补充事项" : "Still to clarify"}</h2>
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
        <h2>{zh ? "付款摘要" : "Payment summary"}</h2>
        <Row
          stacked
          label={zh ? "项目" : "Project"}
          value={spec.name || (zh ? "待约定" : "To be agreed")}
        />
        <Row
          stacked
          label={zh ? "总金额" : "Total"}
          value={
            spec.totalAmountWei === null
              ? zh
                ? "待补充金额"
                : "Amount needed"
              : `${formatWei(spec.totalAmountWei)} ${zh ? "测试 ETH" : "test ETH"}`
          }
        />
        {spec.milestones.map((m) => (
          <Row
            stacked
            key={m.id}
            label={`${m.id}. ${m.title}`}
            value={
              m.amountWei === null
                ? zh
                  ? "待补充金额"
                  : "Amount needed"
                : `${formatWei(m.amountWei)} ${zh ? "测试 ETH" : "test ETH"}`
            }
          />
        ))}
        <Row
          stacked
          label={zh ? "客户 · 存款并验收" : "Client · deposits and approves"}
          value={spec.clientWallet || (zh ? "待补充地址" : "Address needed")}
          mono
        />
        <Row
          stacked
          label={zh ? "服务方 · 收款" : "Developer · receives payments"}
          value={spec.developerWallet || (zh ? "待补充地址" : "Address needed")}
          mono
        />
        <p className="mt-4 text-sm text-muted-foreground">
          {zh
            ? "客户先存入全款，再依次验收各阶段。"
            : "The client deposits the total, then approves each milestone in order."}
        </p>
      </div>
      {compactIssues
        ? issueCount > 0 && (
            <details className="border-t border-border pt-4">
              <summary className="cursor-pointer text-sm">
                {zh ? `其他待处理事项（${issueCount}）` : `Other items to resolve (${issueCount})`}
              </summary>
              <div className="mt-4 space-y-5">{issues}</div>
            </details>
          )
        : issues}
      <SeparateTerms terms={result.separateTerms || []} language={language} />
    </div>
  );
}

export function SeparateTerms({
  terms,
  language = "en",
}: {
  terms: string[];
  language?: DraftLanguage;
}) {
  if (!terms.length) return null;
  const zh = language === "zh";
  return (
    <section>
      <h2>{zh ? "另行书面约定" : "Separate written terms"}</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {zh
          ? "请将这些原文保留在书面协议中，供双方核对；它们不由合约的付款规则执行。"
          : "Keep these in your written agreement. They require human review and are outside the contract's payment rules."}
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
  language = "en",
}: {
  session: DraftSession;
  includeTerms?: boolean;
  language?: DraftLanguage;
}) {
  return (
    <details className="agreement-summary mt-5">
      <summary>
        {language === "zh" ? "原始描述与补充条款" : "Original description & additional terms"}
      </summary>
      <div className="mt-4 space-y-4 text-sm">
        {session.messages.map((message, i) => (
          <p key={i} className="whitespace-pre-wrap break-words">
            {message.content}
          </p>
        ))}
        {includeTerms && (
          <SeparateTerms terms={session.result?.separateTerms || []} language={language} />
        )}
      </div>
    </details>
  );
}
