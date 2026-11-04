import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Shell } from "@/components/Shell";
import { AgreementEditor } from "@/components/AgreementEditor";
import { AgreementNotes, ScopeAcknowledgement, PaymentRules } from "@/components/AgreementNotes";
import { api, type ProjectDraft } from "@/api/client";
import type { Workspace } from "@/api/workspace";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/confirm")({
  head: () => ({ meta: [{ title: "Review your agreement · Accord" }] }),
  component: ConfirmPage,
});
export function ConfirmPage() {
  const nav = useNavigate(),
    [workspace, setWorkspace] = useState<Workspace | null>(null),
    [busy, setBusy] = useState(false),
    [ack, setAck] = useState(false),
    [error, setError] = useState("");
  const active = useRef(false),
    created = useRef<{ id: string; draft: string } | null>(null);
  useEffect(() => setWorkspace(api.getWorkspace()), []);
  async function confirm(draft: ProjectDraft) {
    if (active.current || !workspace) return;
    if (!ack) {
      setError("Please acknowledge which terms this contract can enforce.");
      return;
    }
    active.current = true;
    setBusy(true);
    setError("");
    try {
      const reason = api.validateDraft(draft);
      if (reason) throw new Error(reason);
      const fingerprint = JSON.stringify(draft);
      if (!created.current || created.current.draft !== fingerprint) {
        const p = await api.createAgreement(draft);
        created.current = { id: p.id, draft: fingerprint };
      }
      const context = await api.getAgreement(created.current.id);
      api.saveContext(created.current.id, { ...workspace, draft }, context.spec.specVersion);
      await api.confirmAgreement(created.current.id, context.spec.specVersion);
      api.clearWorkspace();
      await nav({ to: "/projects/$id", params: { id: created.current.id } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <Shell step="Review & confirm">
      <h1>Review your agreement</h1>
      <p className="intro">
        Check the payment rules, then add the two local test accounts. Nothing is generated until
        you ask.
      </p>
      {workspace ? (
        <>
          <AgreementNotes workspace={workspace} />
          <PaymentRules />
          <ScopeAcknowledgement checked={ack} onChange={setAck} />
          <fieldset disabled={busy} className="mt-7">
            <AgreementEditor
              initial={workspace.draft}
              onDirty={() => setAck(false)}
              onSave={confirm}
              onCancel={() => nav({ to: "/" })}
              submitLabel={busy ? "Confirming…" : "Confirm agreement"}
            />
          </fieldset>
          <p className="mt-5 text-xs text-muted-foreground">
            Confirmation is stored by the local backend. It does not deploy a contract or start a
            paid model call.
          </p>
        </>
      ) : (
        <p>Loading draft…</p>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <Button variant="link" className="mt-4 px-0" disabled={busy} onClick={() => nav({ to: "/" })}>
        Back to conversation
      </Button>
    </Shell>
  );
}
