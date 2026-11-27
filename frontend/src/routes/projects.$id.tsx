import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Shell, Row } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { AgreementEditor } from "@/components/AgreementEditor";
import { AgreementNotes, ScopeAcknowledgement, PaymentRules } from "@/components/AgreementNotes";
import { GenerationResultView } from "@/components/GenerationResultView";
import { OperationAssistant } from "@/components/OperationAssistant";
import { DraftSource } from "@/components/DraftSummary";
import {
  DemoLimits,
  MilestoneLedger,
  ProjectLink,
  RefreshHelp,
  TransactionHistory,
} from "@/components/EscrowLedger";
import { approximately, rateText, singleRate } from "@/lib/money";
import { takeAutoDeploy } from "@/lib/autoDeploy";
import {
  api,
  formatWei,
  reconnectDelay,
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
    active = useRef(false),
    // Set after a deploy from this page; the escrow section then scrolls into view once.
    showEscrow = useRef(false);
  const [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false),
    [addition, setAddition] = useState(""),
    [ack, setAck] = useState(false),
    [deploymentUnconfirmed, setDeploymentUnconfirmed] = useState(false),
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
    refetchOnReconnect: "always",
    refetchInterval: (q) =>
      reconnectDelay(q.state.error) ||
      (q.state.data?.run && !q.state.data.run.finishedAt ? 2000 : false),
  });
  const originId = query.data?.context.draftOrigin?.draftId;
  const origin = useQuery({
    queryKey: ["draft", originId],
    queryFn: () => api.getDraft(originId!),
    enabled: Boolean(originId),
    retry: false,
    refetchInterval: (q) => reconnectDelay(q.state.error),
  });
  async function action(work: () => Promise<unknown>, kind?: "deployment") {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      await cache.cancelQueries({ queryKey: key });
      await work();
      await query.refetch();
    } catch (e) {
      if (kind === "deployment" && e instanceof TypeError) {
        setDeploymentUnconfirmed(true);
      } else {
        setError((e as Error).message);
      }
      await query.refetch();
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  // Right after confirming, the checked contract is set up on the test chain without another
  // click (see lib/autoDeploy). Anything else keeps the explicit set-up button.
  const data = query.data;
  useEffect(() => {
    const confirmation = data?.context.confirmation;
    const latest = data?.run;
    if (!data || !confirmation || !latest || busy || data.project.contractAddress) return;
    if (data.context.deployment || !data.context.generatedDeploymentEnabled) return;
    if (!latest.generatedDeploymentEnabled) return;
    if (!takeAutoDeploy(id, confirmation.confirmationId)) return;
    void action(async () => {
      const deployed = await api.deployGeneration(id, latest.id, confirmation);
      showEscrow.current = true;
      await cache.cancelQueries({ queryKey: key });
      cache.setQueryData<typeof data>(
        key,
        (current) => current && { ...current, project: deployed },
      );
    }, "deployment");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, busy, id]);
  if (!query.data)
    return (
      <Shell step="Agreement">
        {query.isError ? (
          <>
            <h1>We couldn't load this agreement</h1>
            <p role="alert" className="intro">
              {reconnectDelay(query.error)
                ? "Reconnecting to the local server. Keep this page open to resume your project."
                : query.error.message}
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
  const currency = "test ETH";
  // Amounts first written in another currency show their approximate original value.
  const rate = singleRate(origin.data?.result?.exchangeRates);
  const confirmation = context.confirmation;
  const source = currentValidatedSource(context, run);
  const sealed = Boolean(context.draftOrigin || context.recoveredOnFreshChain);
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
  const allPaid = project.milestones.every((m) => m.paid);
  const reconnecting = Boolean(reconnectDelay(query.error));
  const alertText =
    error ||
    (reconnecting
      ? source
        ? "Your contract passed its checks. Reconnecting to the local server to check deployment status automatically. You can also choose Refresh status."
        : "Reconnecting to the local server to check project status automatically."
      : query.error?.message ||
        (deploymentUnconfirmed && !generated && !busy && !hasDeployment
          ? "The server is reachable. No deployment is recorded for this checked contract. You can retry deploying this version."
          : ""));
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
  const generateHelp = source
    ? "Only needed if you want a different contract. A new AI generation replaces this checked version and may incur model costs."
    : "Writes the contract with AI, then compiles it, runs static analysis and tests every payment rule. It usually takes a few minutes and may incur model costs.";
  return (
    <Shell
      step={editing ? "Revise agreement" : generated ? "Local escrow" : "Set up contract"}
      progress={editing || !context.confirmation ? 2 : generated || reference ? 4 : 3}
      complete={Boolean(generated && allPaid)}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1>{spec.name}</h1>
        <span className="text-xs text-muted-foreground">
          Version {spec.specVersion} · {context.confirmation ? "Confirmed" : "Needs confirmation"}
        </span>
      </div>
      <p className="intro">
        {generated && allPaid
          ? "All milestones are paid and the escrow is empty. This agreement is complete."
          : generated
            ? "Your generated contract is deployed on the local test chain."
            : reference
              ? "This project uses the handwritten reference contract."
              : hasDeployment
                ? busy
                  ? "Checking local deployment details…"
                  : "Deployment details could not be matched to this project. Refresh its status to check again."
                : canDeploy && context.recoveredOnFreshChain
                  ? "Your checked contract was recovered. You can deploy it on this fresh local chain without generating it again."
                  : canDeploy
                    ? busy
                      ? "Your contract passed its checks. Setting up the escrow on the local test chain…"
                      : "Your contract passed its checks. Set up the escrow on the local test chain to start the deposit and payments."
                    : context.confirmation
                      ? "Generate a contract from your confirmed payment rules, then deploy it locally after its checks pass."
                      : "The agreement changed. Review and confirm this version before generating."}
      </p>
      {context.recoveredOnFreshChain && !hasDeployment && (
        <p className="-mt-5 mb-5 text-sm text-muted-foreground">
          Transactions from an earlier local test chain are not shown here.
        </p>
      )}
      <ProjectLink />
      {context.draftOrigin ? (
        origin.data ? (
          <DraftSource session={origin.data} />
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            {origin.error
              ? `Original conversation could not be loaded. ${origin.error.message}`
              : "Loading original conversation…"}
          </p>
        )
      ) : context.recoveredOnFreshChain ? null : (
        <div className="mt-5">
          <AgreementNotes workspace={notes} />
        </div>
      )}
      {editing && !sealed ? (
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
          {generated ? (
            <section
              className="mt-8 scroll-mt-24 outline-none"
              aria-label="Local escrow"
              tabIndex={-1}
              ref={(element) => {
                // The deploy button sat lower on the page; bring the deposit step into view.
                if (!element || !showEscrow.current) return;
                showEscrow.current = false;
                element.scrollIntoView?.({ block: "start" });
                element.focus({ preventScroll: true });
              }}
            >
              <h2>Local escrow</h2>
              <Row label="Contract address" value={deployment.contractAddress} mono />
              <Row
                label="Escrow balance"
                value={`${formatWei(project.escrowBalanceWei)} ${currency}`}
              />
              <MilestoneLedger project={project} rate={rate} />
              {rate && <p className="-mt-4 mb-6 text-xs text-muted-foreground">{rateText(rate)}</p>}
              <OperationAssistant
                key={deployment.contractAddress}
                project={project}
                disabled={busy || query.isError}
                onProject={updateProject}
                refreshProject={async () => {
                  const refreshed = await query.refetch();
                  if (refreshed.error) throw refreshed.error;
                }}
                quickActions
                rate={rate}
                naturalLanguageEnabled={Boolean(context.operationsEnabled)}
              />
              <DemoLimits />
              <TransactionHistory project={project} />
              <details className="mt-4">
                <summary>Deployment details</summary>
                <Row label="Local chain ID" value={deployment.chainId} />
                <Row label="Generation run" value={deployment.runId} mono />
                <Row label="Source hash" value={deployment.sourceHash} mono />
              </details>
            </section>
          ) : (
            <div className="my-7">
              <Row
                label="Total"
                value={`${formatWei(spec.totalAmountWei)} ${currency}${approximately(spec.totalAmountWei, rate)}`}
              />
              {spec.milestones.map((m) => (
                <Row
                  key={m.id}
                  label={`${m.id}. ${m.title}`}
                  value={`${formatWei(m.amountWei)} ${currency}${approximately(m.amountWei, rate)}`}
                />
              ))}
              {rate && <p className="mt-3 text-xs text-muted-foreground">{rateText(rate)}</p>}
              <details className="mt-4">
                <summary>Participant addresses</summary>
                <Row
                  label="Client · deposits and approves payments"
                  value={spec.clientWallet}
                  mono
                />
                <Row label="Provider · receives payments" value={spec.developerWallet} mono />
              </details>
            </div>
          )}
          {reference && (
            <Button asChild variant="outline">
              <Link to="/reference-projects/$id" params={{ id }}>
                Open reference payment controls
              </Link>
            </Button>
          )}
          {!hasDeployment && (
            <>
              {!sealed && (
                <Button
                  variant="ghost"
                  className="mb-5 -ml-3"
                  disabled={busy}
                  onClick={() => setEditing(true)}
                >
                  Add or change agreement details
                </Button>
              )}
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
              {canDeploy && (
                <section className="panel mb-7" aria-label="Next step">
                  <h2>Next step: set up the escrow</h2>
                  <p className="mt-2 text-sm leading-relaxed">
                    Puts this checked contract, with your confirmed payment rules, on the local test
                    chain. It makes no model request and moves no money.
                  </p>
                  <Button
                    className="mt-4"
                    disabled={busy || query.isError}
                    onClick={() =>
                      action(async () => {
                        const deployed = await api.deployGeneration(id, run.id, confirmation);
                        showEscrow.current = true;
                        await updateProject(deployed);
                      }, "deployment")
                    }
                  >
                    {busy ? "Setting up…" : "Set up the escrow"}
                  </Button>
                </section>
              )}
              {!context.generationEnabled && (
                <p className="mb-5 text-sm text-muted-foreground">
                  AI generation is disabled on this backend. Your rules are saved. The project owner
                  can enable generation when the model and checking tools are configured.
                </p>
              )}
              <Button
                variant={source ? "outline" : "default"}
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
                <p className="mt-3 text-xs text-muted-foreground">{generateHelp}</p>
              )}
            </>
          )}
          {run && <GenerationResultView run={run} currentVersion={spec.specVersion} />}
          {!hasDeployment && source && !canDeploy && (
            <p className="mt-4 text-sm text-muted-foreground">
              Local deployment is unavailable for this run.
            </p>
          )}
        </>
      )}
      {alertText && (
        <p role="alert" className="mt-5 text-sm text-destructive">
          {alertText}
        </p>
      )}
      <div className="mt-6 border-t border-border pt-4">
        {sealed && (
          <Button asChild variant="link" className="px-0">
            <Link to="/" onClick={() => api.setActiveDraftId(null)}>
              Start a new agreement to change these terms
            </Link>
          </Button>
        )}
        <Button
          className="block px-0"
          variant="link"
          disabled={busy}
          onClick={async () => {
            setError("");
            const refreshed = await query.refetch();
            if (refreshed.isSuccess) setDeploymentUnconfirmed(false);
          }}
        >
          Refresh status
        </Button>
        <RefreshHelp />
      </div>
    </Shell>
  );
}
