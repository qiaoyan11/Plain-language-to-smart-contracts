import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shell } from "@/components/ReferenceShell";
import { OperationAssistant } from "@/components/OperationAssistant";
import { PaymentLimits, MilestoneLedger, ProjectLink, TransactionHistory } from "@/components/EscrowLedger";
import { actionBlockReason, api, MOCK_MODE, formatWei, reconnectDelay, type ProjectAction, type Project } from "@/api/client";

export const Route = createFileRoute("/reference-projects/$id")({
  head: () => ({
    meta: [
      { title: "Reference project · Accord" },
      { name: "description", content: "View contract address, escrow balance and milestone payment status." },
      { property: "og:title", content: "Project Details · Smart Contract Escrow" },
      { property: "og:description", content: "View contract address, escrow balance and milestone payment status." },
    ],
  }),
  component: DetailPage,
});

function DetailPage() {
  const { id } = Route.useParams();
  return <ReferenceProject key={id} id={id} />;
}

export function ReferenceProject({ id }: { id: string }) {
  const cache = useQueryClient();
  const key = ["reference-project", id];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const [project, context] = await Promise.all([api.getProject(id), MOCK_MODE ? null : api.getAgreement(id)]);
      const generated = context?.deployment?.kind === "generated" ||
        (!context?.deployment && Boolean(context?.confirmation || context?.latestRunId));
      return { project, generated };
    },
    retry: false,
    refetchOnReconnect: "always",
    refetchInterval: (q) => reconnectDelay(q.state.error),
  });
  const { project, generated } = query.data ?? {};
  const [pending, setPending] = useState<string | null>(null);
  // Deposits and payments move test funds, so they are reviewed before they are sent.
  const [review, setReview] = useState<{ intent: ProjectAction; label: string; key: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function setProject(next: Project) {
    await cache.cancelQueries({ queryKey: key });
    cache.setQueryData<typeof query.data>(key, (previous) => previous && { ...previous, project: next });
  }

  const run = async (intent: ProjectAction, label: string, key: string) => {
    setReview(null);
    setPending(key);
    setMsg(null);
    try {
      await setProject(await api.runAction(id, intent));
      setMsg({ ok: true, text: `${label} succeeded (${MOCK_MODE ? "mock" : "local chain receipt confirmed"})` });
    } catch (e) {
      // Read the recorded state before explaining the failure; a rejected duplicate never pays twice.
      const latest = (await query.refetch()).data?.project;
      const done = latest && intent.action !== "deploy" ? actionBlockReason(latest, intent) : null;
      setMsg({ ok: false, text: reconnectDelay(e)
        ? "The transaction response did not arrive. Check the balance and transaction history before trying again."
        : done && /already/.test(done)
          ? `Nothing new was sent: ${done.toLowerCase()}. Its receipt is shown above.`
          : `${label} failed: ${(e as Error).message}` });
    } finally {
      setPending(null);
    }
  };

  const actions: { intent: ProjectAction; label: string; key: string }[] = project ? [
    { intent: { action: "deploy" }, label: "Deploy contract", key: "deploy" },
    { intent: { action: "deposit" }, label: "Deposit funds", key: "deposit" },
    ...project.milestones.map(m => ({ intent: { action: "acceptMilestone" as const, milestoneId: m.id }, label: `Approve milestone ${m.id} payment`, key: `stage-${m.id}` })),
  ] : [];
  if (generated) return (
    <Shell step="03 / Project">
      <h1>{project?.name}</h1>
      <p className="mt-2">This agreement uses the generated-contract workflow.</p>
      <Link to="/projects/$id" params={{ id }} className="btn btn-outline mt-4 inline-flex">Open agreement</Link>
    </Shell>
  );
  return (
    <Shell step="03 / Project">
      {query.isPending && <p className="text-muted-foreground">Loading…</p>}
      {query.isError && <p role="alert">{reconnectDelay(query.error)
        ? "Reconnecting to the server to check project status automatically."
        : query.error.message}</p>}
      {(project === null || (!project && query.isError && !reconnectDelay(query.error))) && (
        <div className="panel">
          <p>Unable to load this project.</p>
          <Link to="/reference-demo" className="btn btn-outline mt-4 inline-flex">Create a new project</Link>
        </div>
      )}
      {project && (
        <>
          <h1 className="font-display text-4xl font-bold">{project.name}</h1>
          {project.milestones.every(m => m.paid) && <p className="mt-2 text-success font-bold">All milestones paid — project complete.</p>}
          {!MOCK_MODE && <ProjectLink />}
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="panel">
              <div className="text-sm text-muted-foreground">Escrow balance</div>
              <div className="mt-1 break-all font-mono text-3xl font-bold text-primary">{formatWei(project.escrowBalanceWei)} test ETH</div>
            </div>
            <div className="panel">
              <div className="text-sm text-muted-foreground">Contract address</div>
              <div className="mt-1 break-all font-mono text-sm">{project.contractAddress ?? "Not deployed"}</div>
            </div>
          </div>
          <div className="panel mt-4">
            <MilestoneLedger project={project} className="" />
          </div>
          <div className="panel mt-4 grid gap-3 sm:grid-cols-2">
            {actions.map((a) => {
              const reason = actionBlockReason(project, a.intent);
              return (
                <div key={a.key}>
                  <button className="btn btn-primary w-full" disabled={!!reason || pending !== null || query.isError || review !== null}
                    onClick={() => a.intent.action === "deploy" ? run(a.intent, a.label, a.key) : setReview(a)}>
                    {pending === a.key ? "Sending to the local test chain…" : a.label}
                  </button>
                  {reason && <p className="mt-1 text-xs text-muted-foreground">{reason}</p>}
                </div>
              );
            })}
          </div>
          {review && (
            <div className="panel mt-4 space-y-2 text-sm" aria-label="Payment confirmation details">
              <h2 className="font-bold">Review before sending</h2>
              {review.intent.action === "deposit" ? (
                <>
                  <p>Amount: <strong>{formatWei(project.totalAmountWei)} test ETH</strong></p>
                  <p className="break-all">From the client {project.clientWallet} into escrow contract {project.contractAddress}</p>
                  <p>Funds stay in escrow until the client approves each milestone. This version has no refund or timeout release.</p>
                </>
              ) : (() => {
                const m = project.milestones.find(x => review.intent.action === "acceptMilestone" && x.id === review.intent.milestoneId)!;
                return (
                  <>
                    <p>Amount: <strong>{formatWei(m.amountWei)} test ETH</strong></p>
                    <p className="break-all">Recipient: the provider at {project.developerWallet}</p>
                    <p>{`Confirming accepts milestone #${m.id} "${m.title}" and releases its payment to the provider.`}</p>
                  </>
                );
              })()}
              <p>Once confirmed, this transfer cannot be reversed.</p>
              <div className="flex gap-3 pt-1">
                <button className="btn btn-primary" disabled={pending !== null || query.isError}
                  onClick={() => run(review.intent, review.label, review.key)}>
                  {review.intent.action === "deposit" ? "Confirm deposit" : "Confirm acceptance and payment"}
                </button>
                <button className="btn btn-outline" disabled={pending !== null} onClick={() => setReview(null)}>Cancel</button>
              </div>
            </div>
          )}
          {msg && <p role="status" className={`mt-4 text-sm ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.text}</p>}
          {!MOCK_MODE && <OperationAssistant project={project} disabled={pending !== null || query.isError}
            refreshProject={async () => {
              const refreshed = await query.refetch();
              if (refreshed.error) throw refreshed.error;
            }}
            onProject={async next => { await setProject(next); setMsg(null); }} />}
          {!MOCK_MODE && <PaymentLimits />}
          <TransactionHistory project={project} />
        </>
      )}
    </Shell>
  );
}
