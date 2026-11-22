import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Shell, Row } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { AgreementEditor } from "@/components/AgreementEditor";
import { AgreementNotes, ScopeAcknowledgement, PaymentRules } from "@/components/AgreementNotes";
import { GenerationResultView } from "@/components/GenerationResultView";
import { OperationAssistant } from "@/components/OperationAssistant";
import {
  api,
  formatWei,
  type AgreementContext,
  type GenerationRun,
  type Project,
  type ProjectDraft,
} from "@/api/client";
import { emptyWorkspace } from "@/api/workspace";

export const Route = createFileRoute("/projects/$id")({
  head: () => ({ meta: [{ title: "Your agreement · Accord" }] }),
  component: ProjectRoute,
});

function ProjectRoute() {
  const { id } = Route.useParams();
  return <DetailPage key={id} id={id} />;
}

function currentValidatedSource(context: AgreementContext, run: GenerationRun | null) {
  const { spec, confirmation } = context;
  const source = run?.result?.sourceBundle;
  const report = run?.result?.validationReport;
  if (!confirmation || !run || !source || !report) return null;
  const current =
    run.id === context.latestRunId &&
    run.projectId === spec.projectId &&
    run.specVersion === spec.specVersion &&
    confirmation.specVersion === spec.specVersion &&
    confirmation.projectId === spec.projectId &&
    run.confirmationId === confirmation.confirmationId;
  const validated =
    run.finishedAt &&
    run.status === "completed" &&
    run.result?.status === "validated" &&
    report.status === "passed" &&
    report.sourceHash === source.sourceHash;
  return current && validated ? source : null;
}

export function DetailPage({ id }: { id: string }) {
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
      const [project, context] = await Promise.all([
        api.getProjectSnapshot(id),
        api.getAgreement(id),
      ]);
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
      await query.refetch();
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
  const confirmation = context.confirmation;
  const source = currentValidatedSource(context, run);
  const deployment = context.deployment;
  const hasDeployment = Boolean(project.contractAddress || deployment);
  const sameAddress =
    deployment &&
    project.contractAddress &&
    deployment.contractAddress.toLowerCase() === project.contractAddress.toLowerCase();
  const generated =
    sameAddress &&
    deployment.kind === "generated" &&
    source &&
    deployment.runId === run?.id &&
    deployment.specVersion === spec.specVersion &&
    deployment.sourceHash === source.sourceHash;
  const reference = sameAddress && deployment.kind === "reference";
  const canDeploy =
    !hasDeployment &&
    source &&
    confirmation &&
    context.generatedDeploymentEnabled &&
    run?.generatedDeploymentEnabled;
  const draft: ProjectDraft = {
    name: spec.name,
    clientWallet: spec.clientWallet,
    developerWallet: spec.developerWallet,
    milestones: spec.milestones.map(({ title, amountWei }) => ({ title, amountWei })),
  };
  const notes = api.getContext(id);
  const running = Boolean(run && !run.finishedAt);
  async function updateProject(next: Project) {
    await cache.cancelQueries({ queryKey: key });
    cache.setQueryData<typeof query.data>(key, (data) => data && { ...data, project: next });
  }
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
    <Shell step={editing ? "Revise agreement" : generated ? "Local escrow" : "Generate & check"}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1>{spec.name}</h1>
        <span className="text-xs text-muted-foreground">
          Version {spec.specVersion} · {context.confirmation ? "Confirmed" : "Needs confirmation"}
        </span>
      </div>
      <p className="intro">
        {generated
          ? "Your generated contract is deployed on the local test chain."
          : reference
            ? "This project uses the handwritten reference contract."
            : hasDeployment
              ? busy
                ? "Checking local deployment details…"
                : "Deployment details could not be matched to this project. Refresh its status to check again."
              : context.confirmation
                ? "Agent 2 generates a contract from your confirmed payment rules. You can deploy it locally after its development checks pass."
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
            <Row
              label="Total"
              value={`${formatWei(generated ? project.totalAmountWei : spec.totalAmountWei)} test ETH`}
            />
            {(generated ? project.milestones : spec.milestones).map((m) => (
              <Row
                key={m.id}
                label={`${m.id}. ${m.title}`}
                value={`${formatWei(m.amountWei)} test ETH${"paid" in m ? (m.paid ? " · Paid" : " · Unpaid") : ""}`}
              />
            ))}
            <details className="mt-4">
              <summary>Participant addresses</summary>
              <Row label="Client · approves payments" value={spec.clientWallet} mono />
              <Row label="Developer · receives payments" value={spec.developerWallet} mono />
            </details>
          </div>
          {reference && (
            <Button asChild variant="outline">
              <Link to="/reference-projects/$id" params={{ id }}>
                Open reference payment controls
              </Link>
            </Button>
          )}
          {!hasDeployment && (
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
          {generated && (
            <section className="mt-8">
              <h2>Local escrow</h2>
              <Row label="Contract address" value={deployment.contractAddress} mono />
              <Row
                label="Escrow balance"
                value={`${formatWei(project.escrowBalanceWei)} test ETH`}
              />
              <Row label="Deposit" value={project.funded ? "Funded" : "Awaiting deposit"} />
              <details className="mt-4">
                <summary>Deployment and transactions</summary>
                <Row label="Local chain ID" value={deployment.chainId} />
                <Row label="Generation run" value={deployment.runId} mono />
                <Row label="Source hash" value={deployment.sourceHash} mono />
                {project.transactions.map((tx) => (
                  <Row
                    key={tx.hash}
                    label={`${tx.action}${tx.milestoneId ? ` · stage ${tx.milestoneId}` : ""} · block ${tx.blockNumber}`}
                    value={tx.hash}
                    mono
                  />
                ))}
              </details>
              {context.operationsEnabled ? (
                <OperationAssistant
                  key={deployment.contractAddress}
                  project={project}
                  disabled={busy || query.isError}
                  onProject={updateProject}
                />
              ) : (
                <p className="mt-5 text-sm text-muted-foreground">
                  Plain-language operations are disabled on this backend. The project owner can
                  enable Agent 3 in local mode.
                </p>
              )}
            </section>
          )}
          {run && <GenerationResultView run={run} currentVersion={spec.specVersion} />}
          {canDeploy && (
            <div className="mt-5">
              <Button
                disabled={busy || query.isError}
                onClick={() =>
                  action(async () => {
                    await updateProject(await api.deployGeneration(id, run.id, confirmation));
                  })
                }
              >
                Deploy generated contract locally
              </Button>
              <p className="mt-3 text-xs text-muted-foreground">
                Deploys this checked version with your confirmed payment rules on the local test
                chain.
              </p>
            </div>
          )}
          {!hasDeployment && source && !canDeploy && (
            <p className="mt-4 text-sm text-muted-foreground">
              Local deployment is unavailable for this run.
            </p>
          )}
        </>
      )}
      {(error || query.isError) && (
        <p role="alert" className="mt-5 text-sm text-destructive">
          {error || query.error?.message}
        </p>
      )}
      <Button
        className="mt-5"
        variant="link"
        disabled={busy}
        onClick={() => {
          setError("");
          void query.refetch();
        }}
      >
        Refresh status
      </Button>
    </Shell>
  );
}
