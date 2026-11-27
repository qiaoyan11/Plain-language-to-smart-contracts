import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Row, Shell } from "@/components/ReferenceShell";
import { OperationAssistant } from "@/components/OperationAssistant";
import { actionBlockReason, api, MOCK_MODE, formatWei, reconnectDelay, type ProjectAction, type Project } from "@/api/client";

export const Route = createFileRoute("/reference-projects/$id")({
  head: () => ({
    meta: [
      { title: "Project Details · Smart Contract Escrow (Local Demo)" },
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
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function setProject(next: Project) {
    await cache.cancelQueries({ queryKey: key });
    cache.setQueryData<typeof query.data>(key, (previous) => previous && { ...previous, project: next });
  }

  const run = async (intent: ProjectAction, label: string, key: string) => {
    setPending(key);
    setMsg(null);
    try {
      await setProject(await api.runAction(id, intent));
      setMsg({ ok: true, text: `${label} succeeded (${MOCK_MODE ? "mock" : "local chain receipt confirmed"})` });
    } catch (e) {
      setMsg({ ok: false, text: reconnectDelay(e)
        ? "The transaction response did not arrive. Check the balance and transaction history before trying again."
        : `${label} failed: ${(e as Error).message}` });
      await query.refetch();
    } finally {
      setPending(null);
    }
  };

  const actions: { intent: ProjectAction; label: string; key: string }[] = project ? [
    { intent: { action: "deploy" }, label: "Deploy contract", key: "deploy" },
    { intent: { action: "deposit" }, label: "Deposit funds", key: "deposit" },
    ...project.milestones.map(m => ({ intent: { action: "acceptMilestone" as const, milestoneId: m.id }, label: `Approve Stage ${m.id} payment`, key: `stage-${m.id}` })),
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
        ? "Reconnecting to the local server to check project status automatically."
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
          {project.milestones.every(m => m.paid) && <p className="mt-2 text-success font-bold">All stages paid — project complete.</p>}
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
            <Row label="Total" value={`${formatWei(project.totalAmountWei)} test ETH`} />
            <Row label="Client wallet" value={project.clientWallet} mono />
            <Row label="Developer wallet" value={project.developerWallet} mono />
            {project.milestones.map((s) => (
              <Row key={s.id} label={`Stage ${s.id} · ${s.title} (${formatWei(s.amountWei)} ETH)`}
                value={<span className={s.paid ? "badge badge-paid" : "badge"}>{s.paid ? "Paid" : "Unpaid"}</span>} />
            ))}
          </div>
          <div className="panel mt-4 grid gap-3 sm:grid-cols-2">
            {actions.map((a) => {
              const reason = actionBlockReason(project, a.intent);
              return (
                <div key={a.key}>
                  <button className="btn btn-primary w-full" disabled={!!reason || pending !== null || query.isError}
                    onClick={() => run(a.intent, a.label, a.key)}>
                    {pending === a.key ? "Waiting for confirmation…" : a.label}
                  </button>
                  {reason && <p className="mt-1 text-xs text-muted-foreground">{reason}</p>}
                </div>
              );
            })}
          </div>
          {!MOCK_MODE && <OperationAssistant project={project} disabled={pending !== null || query.isError}
            refreshProject={async () => {
              const refreshed = await query.refetch();
              if (refreshed.error) throw refreshed.error;
            }}
            onProject={async next => { await setProject(next); setMsg(null); }} />}
          {project.transactions?.length ? <div className="panel mt-4">
            <h2 className="font-bold">Confirmed local transactions</h2>
            {project.transactions.map(tx => <div key={tx.hash} className="mt-2 break-all text-xs font-mono">{tx.action}{tx.milestoneId ? ` ${tx.milestoneId}` : ""} · block {tx.blockNumber}<br />{tx.hash}</div>)}
          </div> : null}
          {msg && <p className={`mt-4 text-sm ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.text}</p>}
        </>
      )}
    </Shell>
  );
}
