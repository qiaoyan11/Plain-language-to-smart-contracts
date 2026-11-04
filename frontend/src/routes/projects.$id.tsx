import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Shell, Row } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { AgreementEditor } from "@/components/AgreementEditor";
import { AgreementNotes, ScopeAcknowledgement, PaymentRules } from "@/components/AgreementNotes";
import { GenerationResultView } from "@/components/GenerationResultView";
import { api, formatWei, type ProjectDraft } from "@/api/client";
import { emptyWorkspace } from "@/api/workspace";

export const Route = createFileRoute("/projects/$id")({
  head: () => ({ meta: [{ title: "Your agreement · Accord" }] }),
  component: DetailPage,
});
function DetailPage() {
  const { id } = Route.useParams();
  const cache = useQueryClient(),
    active = useRef(false);
  const [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false),
    [addition, setAddition] = useState(""),
    [ack, setAck] = useState(false),
    [error, setError] = useState("");
  const key = ["agreement", id];
  const query = useQuery({
    queryKey: key,
    retry: false,
    queryFn: async () => {
      const [project, context] = await Promise.all([api.getProject(id), api.getAgreement(id)]);
      const run = context.latestRunId ? await api.getGeneration(id, context.latestRunId) : null;
      return { project, context, run };
    },
    refetchInterval: (q) => (q.state.data?.run && !q.state.data.run.finishedAt ? 2000 : false),
  });
  async function action(work: () => Promise<unknown>) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      await cache.cancelQueries({ queryKey: key });
      await work();
      await query.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  if (!query.data)
    return (
      <Shell step="Agreement">
        {query.isError ? (
          <>
            <h1>We couldn't load this agreement</h1>
            <p role="alert" className="intro">
              {query.error.message} Local projects reset when the backend restarts.
            </p>
            <Button onClick={() => query.refetch()}>Try again</Button>
            <Button asChild variant="ghost">
              <Link to="/">Start an agreement</Link>
            </Button>
          </>
        ) : (
          <p>Loading agreement…</p>
        )}
      </Shell>
    );
  const { project, context, run } = query.data;
  const spec = context.spec;
  const draft: ProjectDraft = {
    name: spec.name,
    clientWallet: spec.clientWallet,
    developerWallet: spec.developerWallet,
    milestones: spec.milestones.map(({ title, amountWei }) => ({ title, amountWei })),
  };
  const notes = api.getContext(id);
  const running = Boolean(run && !run.finishedAt);
  async function revise(next: ProjectDraft) {
    await action(async () => {
      const updated = await api.updateTerms(id, spec.specVersion, next);
      const original = notes || { ...emptyWorkspace(), draft };
      api.saveContext(
        id,
        {
          ...original,
          draft: next,
          messages: addition.trim()
            ? [...original.messages, { role: "user", content: addition }]
            : original.messages,
        },
        updated.spec.specVersion,
      );
      setEditing(false);
      setAddition("");
      setAck(false);
    });
  }
  return (
    <Shell step={editing ? "Revise agreement" : "Generate & check"}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1>{spec.name}</h1>
        <span className="text-xs text-muted-foreground">
          Version {spec.specVersion} · {context.confirmation ? "Confirmed" : "Needs confirmation"}
        </span>
      </div>
      <p className="intro">
        {project?.contractAddress
          ? "This project uses the handwritten reference contract."
          : context.confirmation
            ? "Your confirmed payment rules are ready for Agent 2. Generation does not deploy a contract."
            : "The agreement changed. Review and confirm this version before generating."}
      </p>
      <AgreementNotes workspace={notes} />
      {editing ? (
        <div className="mt-7">
          <label className="mb-7 block">
            <span className="field-label">Add a detail or correction · saved for human review</span>
            <textarea
              className="field min-h-28"
              maxLength={20000}
              value={addition}
              onChange={(e) => setAddition(e.target.value)}
            />
          </label>
          <p className="mb-5 text-sm text-muted-foreground">
            Update payment fields below yourself. Saving any change invalidates confirmation and
            earlier results. Unsupported rules are not added to the contract.
          </p>
          <fieldset disabled={busy}>
            <AgreementEditor
              initial={draft}
              onSave={revise}
              onCancel={() => {
                setEditing(false);
                setAddition("");
              }}
              submitLabel="Save changes & require confirmation"
            />
          </fieldset>
        </div>
      ) : (
        <>
          <div className="my-7">
            <Row label="Total" value={`${formatWei(spec.totalAmountWei)} test ETH`} />
            {spec.milestones.map((m) => (
              <Row
                key={m.id}
                label={`${m.id}. ${m.title}`}
                value={`${formatWei(m.amountWei)} test ETH`}
              />
            ))}
            <details className="mt-4">
              <summary>Participant addresses</summary>
              <Row label="Client · approves payments" value={spec.clientWallet} mono />
              <Row label="Developer · receives payments" value={spec.developerWallet} mono />
            </details>
          </div>
          {project?.contractAddress ? (
            <Button asChild variant="outline">
              <Link to="/reference-projects/$id" params={{ id }}>
                Open reference payment controls
              </Link>
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                className="mb-5 -ml-3"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                Add or change agreement details
              </Button>
              {!context.confirmation && (
                <div className="mb-7">
                  <PaymentRules />
                  <ScopeAcknowledgement checked={ack} onChange={setAck} />
                  <Button
                    className="mt-5"
                    disabled={!ack || busy}
                    onClick={() => action(() => api.confirmAgreement(id, spec.specVersion))}
                  >
                    Confirm this version
                  </Button>
                </div>
              )}
              {!context.generationEnabled && (
                <p className="mb-5 text-sm text-muted-foreground">
                  AI generation is disabled on this backend. Your rules are saved. The project owner
                  can enable generation when the model and checking tools are configured.
                </p>
              )}
              <Button
                disabled={
                  !context.confirmation ||
                  !context.generationEnabled ||
                  running ||
                  busy ||
                  query.isError
                }
                onClick={() =>
                  action(() => api.startGeneration(id, context, run?.finishedAt ? run.id : null))
                }
              >
                {running
                  ? "Generating and checking…"
                  : run
                    ? "Start another generation"
                    : "Generate & check contract"}
              </Button>
              {context.generationEnabled && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Starts a paid model request with up to 3 repairs. It stops early when checks pass
                  or a tool fails.
                </p>
              )}
            </>
          )}
          {run && <GenerationResultView run={run} currentVersion={spec.specVersion} />}
          <p className="mt-8 text-sm text-muted-foreground">
            Generated-contract deployment is not available yet. The independent reference demo uses
            a handwritten contract.
          </p>
        </>
      )}
      {(error || query.isError) && (
        <p role="alert" className="mt-5 text-sm text-destructive">
          {error || query.error?.message}
        </p>
      )}
      <Button className="mt-5" variant="link" disabled={busy} onClick={() => query.refetch()}>
        Refresh status
      </Button>
    </Shell>
  );
}
