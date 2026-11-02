import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Row, Shell } from "@/components/Shell";
import { api, STAGES, TOTAL_ETH, type ProjectDraft } from "@/api/client";

export const Route = createFileRoute("/confirm")({
  head: () => ({
    meta: [
      { title: "Review Rules · Smart Contract Escrow (Local Demo)" },
      { name: "description", content: "Review project details and milestone payment rules." },
      { property: "og:title", content: "Review Rules · Smart Contract Escrow" },
      { property: "og:description", content: "Review project details and milestone payment rules." },
    ],
  }),
  component: ConfirmPage,
});

function ConfirmPage() {
  const nav = useNavigate();
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(api.getDraft());
    setLoaded(true);
  }, []);

  const create = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const p = await api.createProject(draft);
      nav({ to: "/projects/$id", params: { id: p.id } });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Shell step="02 / Review">
      <h1 className="font-display text-4xl font-bold">Review payment rules</h1>
      {loaded && !draft ? (
        <div className="panel mt-8">
          <p>No project draft to review.</p>
          <button className="btn btn-outline mt-4" onClick={() => nav({ to: "/" })}>Create one</button>
        </div>
      ) : draft && (
        <div className="panel mt-8">
          <Row label="Project name" value={draft.name} />
          <Row label="Client wallet" value={draft.clientWallet} mono />
          <Row label="Developer wallet" value={draft.developerWallet} mono />
          <Row label="Total" value={`${TOTAL_ETH} test ETH`} />
          {STAGES.map((s, i) => (
            <Row key={s.key} label={`Stage ${i + 1} · ${s.name}`} value={`${s.amount} ETH`} />
          ))}
          <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>The client must deposit the full amount before any payment can be approved.</li>
            <li>Stage 2 can only be approved after Stage 1 is paid.</li>
            <li>Each stage can only be paid once.</li>
          </ul>
          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
          <div className="mt-6 flex gap-3">
            <button className="btn btn-outline flex-1" disabled={busy} onClick={() => nav({ to: "/" })}>Back to edit</button>
            <button className="btn btn-primary flex-1" disabled={busy} onClick={create}>
              {busy ? "Creating…" : "Confirm & create"}
            </button>
          </div>
        </div>
      )}
    </Shell>
  );
}
