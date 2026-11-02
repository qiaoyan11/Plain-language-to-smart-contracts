import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Row, Shell } from "@/components/Shell";
import { actionBlockReason, api, MOCK_MODE, STAGES, type ActionKind, type Project } from "@/api/client";

export const Route = createFileRoute("/projects/$id")({
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

const ACTIONS: { kind: ActionKind; label: string }[] = [
  { kind: "deploy", label: "Deploy contract" },
  { kind: "deposit", label: "Deposit funds" },
  { kind: "stage1", label: "Approve Stage 1 payment" },
  { kind: "stage2", label: "Approve Stage 2 payment" },
];

function DetailPage() {
  const { id } = Route.useParams();
  const [project, setProject] = useState<Project | null | undefined>(undefined);
  const [pending, setPending] = useState<ActionKind | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.getProject(id).then(setProject).catch(e => { setProject(null); setMsg({ok:false,text:e.message}); });
  }, [id]);

  const run = async (kind: ActionKind, label: string) => {
    setPending(kind);
    setMsg(null);
    try {
      setProject(await api.runAction(id, kind));
      setMsg({ ok: true, text: `${label} succeeded (${MOCK_MODE ? "mock" : "local chain receipt confirmed"})` });
    } catch (e) {
      setMsg({ ok: false, text: `${label} failed: ${(e as Error).message}` });
    } finally {
      setPending(null);
    }
  };

  return (
    <Shell step="03 / Project">
      {project === undefined && <p className="text-muted-foreground">Loading…</p>}
      {project === null && (
        <div className="panel">
          <p>Project not found.</p>
          <Link to="/" className="btn btn-outline mt-4 inline-flex">Create a new project</Link>
        </div>
      )}
      {project === null && msg && <p className="text-destructive">{msg.text}</p>}
      {project && (
        <>
          <h1 className="font-display text-4xl font-bold">{project.name}</h1>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="panel">
              <div className="text-sm text-muted-foreground">Escrow balance</div>
              <div className="mt-1 font-mono text-3xl font-bold text-primary">{project.escrowBalance} ETH</div>
            </div>
            <div className="panel">
              <div className="text-sm text-muted-foreground">Contract address</div>
              <div className="mt-1 break-all font-mono text-sm">{project.contractAddress ?? "Not deployed"}</div>
            </div>
          </div>
          <div className="panel mt-4">
            <Row label="Client wallet" value={project.clientWallet} mono />
            <Row label="Developer wallet" value={project.developerWallet} mono />
            {STAGES.map((s, i) => (
              <Row key={s.key} label={`Stage ${i + 1} · ${s.name} (${s.amount} ETH)`}
                value={<span className={project.paid[s.key] ? "badge badge-paid" : "badge"}>{project.paid[s.key] ? "Paid" : "Unpaid"}</span>} />
            ))}
          </div>
          <div className="panel mt-4 grid gap-3 sm:grid-cols-2">
            {ACTIONS.map((a) => {
              const reason = actionBlockReason(project, a.kind);
              return (
                <div key={a.kind}>
                  <button className="btn btn-primary w-full" disabled={!!reason || pending !== null}
                    onClick={() => run(a.kind, a.label)}>
                    {pending === a.kind ? "Waiting for confirmation…" : a.label}
                  </button>
                  {reason && <p className="mt-1 text-xs text-muted-foreground">{reason}</p>}
                </div>
              );
            })}
          </div>
          {project.transactions?.length ? <div className="panel mt-4">
            <h2 className="font-bold">Confirmed local transactions</h2>
            {project.transactions.map(tx => <div key={tx.hash} className="mt-2 break-all text-xs font-mono">{tx.action} · block {tx.blockNumber}<br />{tx.hash}</div>)}
          </div> : null}
          {msg && <p className={`mt-4 text-sm ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.text}</p>}
        </>
      )}
    </Shell>
  );
}
