import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Row, Shell } from "@/components/ReferenceShell";
import { OperationAssistant } from "@/components/OperationAssistant";
import { actionBlockReason, api, MOCK_MODE, formatWei, type ProjectAction, type Project } from "@/api/client";

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

function ReferenceProject({ id }: { id: string }) {
  const [project, setProject] = useState<Project | null | undefined>(undefined);
  const [generated, setGenerated] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getProject(id), MOCK_MODE ? null : api.getAgreement(id)])
      .then(([next, context]) => {
        if (cancelled) return;
        setGenerated(context?.deployment?.kind === "generated" ||
          (!context?.deployment && Boolean(context?.confirmation || context?.latestRunId)));
        setProject(next);
      })
      .catch(e => { if (!cancelled) { setProject(null); setMsg({ok:false,text:e.message}); } });
    return () => { cancelled = true; };
  }, [id]);

  const run = async (intent: ProjectAction, label: string, key: string) => {
    setPending(key);
    setMsg(null);
    try {
      setProject(await api.runAction(id, intent));
      setMsg({ ok: true, text: `${label} succeeded (${MOCK_MODE ? "mock" : "local chain receipt confirmed"})` });
    } catch (e) {
      setMsg({ ok: false, text: `${label} failed: ${(e as Error).message}` });
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
      {project === undefined && <p className="text-muted-foreground">Loading…</p>}
      {project === null && (
        <div className="panel">
          <p>Unable to load this project.</p>
          <Link to="/reference-demo" className="btn btn-outline mt-4 inline-flex">Create a new project</Link>
        </div>
      )}
      {project === null && msg && <p className="text-destructive">{msg.text}</p>}
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
                  <button className="btn btn-primary w-full" disabled={!!reason || pending !== null}
                    onClick={() => run(a.intent, a.label, a.key)}>
                    {pending === a.key ? "Waiting for confirmation…" : a.label}
                  </button>
                  {reason && <p className="mt-1 text-xs text-muted-foreground">{reason}</p>}
                </div>
              );
            })}
          </div>
          {!MOCK_MODE && <OperationAssistant project={project} disabled={pending !== null}
            onProject={next => { setProject(next); setMsg(null); }} />}
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
