import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Shell } from "@/components/Shell";
import { DraftSummary, DraftSource, draftReady } from "@/components/DraftSummary";
import { PaymentRules, ScopeAcknowledgement } from "@/components/AgreementNotes";
import { useActiveDraft } from "@/hooks/use-active-draft";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { isChineseDraft } from "@/lib/draft-language";

export const Route = createFileRoute("/confirm")({
  head: () => ({ meta: [{ title: "Review your agreement · Accord" }] }),
  component: ConfirmPage,
});
export function ConfirmPage() {
  const nav = useNavigate();
  const cache = useQueryClient();
  const { id, query, session } = useActiveDraft();
  const [busy, setBusy] = useState(false);
  const [ackRevision, setAckRevision] = useState<number | null>(null);
  const [error, setError] = useState("");
  const active = useRef(false);
  const ready = draftReady(session) && !query.isFetching && !query.isError;
  const zh = isChineseDraft(session?.messages ?? []);
  const language = zh ? "zh" : "en";
  async function confirm() {
    if (
      active.current ||
      !session ||
      !ready ||
      ackRevision !== session.revision ||
      session.confirmedProjectId
    )
      return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      await cache.cancelQueries({ queryKey: ["draft", id] });
      const confirmed = await api.confirmDraft(session.id, session.revision);
      cache.setQueryData(["draft", id], { ...session, confirmedProjectId: confirmed.project.id });
      await nav({ to: "/projects/$id", params: { id: confirmed.project.id } });
    } catch (caught) {
      setError((caught as Error).message);
      setAckRevision(null);
      const latest = await query.refetch();
      if (latest.data?.confirmedProjectId)
        await nav({ to: "/projects/$id", params: { id: latest.data.confirmedProjectId } });
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <Shell step={zh ? "核对并确认" : "Review & confirm"}>
      <h1>{zh ? "核对付款约定" : "Review your agreement"}</h1>
      <p className="intro">
        {zh ? "请核对双方钱包和每期金额。确认后会保存这一版约定，供生成合约使用。"
          : "Check the payment amounts and both wallets. Confirming saves this version for contract generation."}
      </p>
      {session ? (
        <>
          <DraftSummary result={session.result} language={language} />
          <DraftSource session={session} includeTerms={false} language={language} />
          {session.confirmedProjectId ? (
            <Button
              className="mt-5"
              onClick={() =>
                nav({ to: "/projects/$id", params: { id: session.confirmedProjectId! } })
              }
            >
              {zh ? "打开已确认的项目" : "Open confirmed project"}
            </Button>
          ) : (
            <>
              <PaymentRules spec={ready ? session.result?.draftSpec : undefined} zh={zh} />
              <ScopeAcknowledgement
                zh={zh}
                checked={ackRevision === session.revision}
                onChange={(checked) => setAckRevision(checked ? session.revision : null)}
              />
              <Button
                className="mt-5"
                disabled={busy || !ready || ackRevision !== session.revision}
                onClick={() => void confirm()}
              >
                {busy ? (zh ? "正在确认…" : "Confirming…") : (zh ? "确认付款约定" : "Confirm agreement")}
              </Button>
              {!draftReady(session) && (
                <p className="mt-3 text-sm">
                  {zh ? "请先回到对话，补齐待确认的条款。" : "Return to the conversation to resolve the remaining terms before confirming."}
                </p>
              )}
            </>
          )}
        </>
      ) : id === undefined || (id && query.isPending) ? (
        <p>Loading agreement…</p>
      ) : (
        <p>Open your conversation to review an agreement.</p>
      )}
      {(error || query.error || session?.lastError) && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error || query.error?.message || session?.lastError}
        </p>
      )}
      <Button variant="link" className="mt-4 px-0" disabled={busy} onClick={() => nav({ to: "/" })}>
        {zh ? "返回对话" : "Back to conversation"}
      </Button>
    </Shell>
  );
}
