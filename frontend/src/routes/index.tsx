import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { api, MOCK_MODE, isValidAddress, ethToWei, formatWei, totalWei } from "@/api/client";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Create Project · Smart Contract Escrow (Local Demo)" },
      { name: "description", content: "Create a milestone-based smart contract escrow project (local development demo)." },
      { property: "og:title", content: "Create Project · Smart Contract Escrow" },
      { property: "og:description", content: "Create a milestone-based smart contract escrow project (local development demo)." },
    ],
  }),
  component: CreatePage,
});

function CreatePage() {
  const nav = useNavigate();
  const [form, setForm] = useState({ name: "", clientWallet: "", developerWallet: "" });
  const [milestones, setMilestones] = useState([
    { title: "Homepage complete", amountEth: "0.003" },
    { title: "Full site complete", amountEth: "0.007" },
  ]);
  const [error, setError] = useState("");

  useEffect(() => {
    const d = api.getDraft();
    if (d) {
      setForm({ name: d.name, clientWallet: d.clientWallet, developerWallet: d.developerWallet });
      setMilestones(d.milestones.map(m => ({ title: m.title, amountEth: formatWei(m.amountWei) })));
    }
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return setError("Please enter a project name");
    if (!isValidAddress(form.clientWallet)) return setError("Invalid client wallet address (0x + 40 hex characters)");
    if (!isValidAddress(form.developerWallet)) return setError("Invalid developer wallet address");
    if (form.clientWallet.trim().toLowerCase() === form.developerWallet.trim().toLowerCase()) return setError("Client and developer must be different");
    try {
      const terms = milestones.map(m => ({ title: m.title.trim(), amountWei: ethToWei(m.amountEth) }));
      totalWei(terms);
      api.saveDraft({ ...form, name: form.name.trim(), clientWallet: form.clientWallet.trim(), developerWallet: form.developerWallet.trim(), milestones: terms });
      nav({ to: "/confirm" });
    } catch (e) { setError((e as Error).message); }
  };

  const field = (key: keyof typeof form, label: string, ph: string) => (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      <input className="field" maxLength={key === "name" ? 120 : 42} value={form[key]} placeholder={ph}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </label>
  );

  let total = "—";
  try { total = formatWei(totalWei(milestones.map(m => ({ title: m.title, amountWei: ethToWei(m.amountEth) })))); } catch { /* Incomplete input is validated on submit. */ }
  return (
    <Shell step="01 / Create">
      <h1 className="font-display text-4xl font-bold">Create an escrow project</h1>
      <p className="mt-2 text-muted-foreground">Funds are locked in the contract and released to the developer stage by stage.</p>
      <form onSubmit={submit} className="panel mt-8 space-y-5">
        {!MOCK_MODE && <button type="button" className="btn btn-outline" onClick={async () => {
          try { const accounts = await api.getLocalAccounts(); setForm(f => ({ ...f, ...accounts })); setError(""); }
          catch (e) { setError((e as Error).message); }
        }}>Use local demo accounts</button>}
        {field("name", "Project name", "e.g. Company website")}
        {field("clientWallet", "Client wallet address", "0x...")}
        {field("developerWallet", "Developer wallet address", "0x...")}
        <fieldset className="space-y-4">
          <legend className="font-bold">Payment stages</legend>
          <p className="text-sm text-muted-foreground">Add 1–5 stages in payment order. Each stage needs a positive amount.</p>
          {milestones.map((m, i) => <div key={i} className="rounded-md border p-4 space-y-3">
            <div className="flex items-center justify-between"><span className="font-medium">Stage {i + 1}</span>
              <button type="button" className="btn btn-outline" aria-label={`Remove stage ${i + 1}`} disabled={milestones.length === 1}
                onClick={() => setMilestones(ms => ms.filter((_, n) => n !== i))}>Remove</button></div>
            <label className="block"><span className="mb-1 block text-sm">Stage {i + 1} title</span>
              <input className="field" maxLength={120} value={m.title} onChange={e => setMilestones(ms => ms.map((x, n) => n === i ? { ...x, title: e.target.value } : x))} /></label>
            <label className="block"><span className="mb-1 block text-sm">Stage {i + 1} amount in test ETH</span>
              <input className="field font-mono" inputMode="decimal" value={m.amountEth} placeholder="0.001"
                onChange={e => setMilestones(ms => ms.map((x, n) => n === i ? { ...x, amountEth: e.target.value } : x))} /></label>
          </div>)}
          <button type="button" className="btn btn-outline" disabled={milestones.length === 5}
            onClick={() => setMilestones(ms => [...ms, { title: "", amountEth: "" }])}>Add stage</button>
        </fieldset>
        <div className="rounded-md bg-muted p-4 text-sm flex justify-between font-medium"><span>Total</span><span className="font-mono break-all">{total} test ETH</span></div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <button type="submit" className="btn btn-primary w-full">Next: Review rules</button>
      </form>
    </Shell>
  );
}
