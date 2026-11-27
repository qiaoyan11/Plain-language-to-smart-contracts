import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Shell } from "@/components/Shell";
import { DraftSummary, DraftSource, draftReady } from "@/components/DraftSummary";
import { PaymentRules, ScopeAcknowledgement } from "@/components/AgreementNotes";
import { useActiveDraft } from "@/hooks/use-active-draft";
import { api, reconnectDelay } from "@/api/client";
import { Button } from "@/components/ui/button";

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
    <Shell step="Review & confirm" progress={2}>
      <h1>Review your agreement</h1>
      <p className="intro">
        Check the payment amounts and both wallets. Confirming saves this version for contract
        generation.
      </p>
      {session ? (
        <>
          <DraftSummary result={session.result} />
          <DraftSource session={session} includeTerms={false} />
          {session.confirmedProjectId ? (
            <Button
              className="mt-5"
              onClick={() =>
                nav({ to: "/projects/$id", params: { id: session.confirmedProjectId! } })
              }
            >
              Open confirmed project
            </Button>
          ) : (
            <>
              <PaymentRules spec={ready ? session.result?.draftSpec : undefined} />
              <ScopeAcknowledgement
                checked={ackRevision === session.revision}
                onChange={(checked) => setAckRevision(checked ? session.revision : null)}
              />
              <Button
                className="mt-5"
                disabled={busy || !ready || ackRevision !== session.revision}
                onClick={() => void confirm()}
              >
                {busy ? "Confirming…" : "Confirm agreement"}
              </Button>
              <p className="mt-3 text-xs text-muted-foreground">
                Next, Accord writes the contract and checks it automatically. Nothing is deployed and
                no funds move until you choose to.
              </p>
              {!draftReady(session) && (
                <p className="mt-3 text-sm">
                  Return to the conversation to resolve the remaining terms before confirming.
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
          {reconnectDelay(query.error)
            ? "Reconnecting to the local server to check your saved draft and confirmation."
            : error || query.error?.message || session?.lastError}
        </p>
      )}
      <Button variant="link" className="mt-4 px-0" disabled={busy} onClick={() => nav({ to: "/" })}>
        Back to conversation
      </Button>
    </Shell>
  );
}
