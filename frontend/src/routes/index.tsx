import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { api, MOCK_MODE, isValidAddress, STAGES, TOTAL_ETH } from "@/api/client";

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
  const [error, setError] = useState("");

  useEffect(() => {
    const d = api.getDraft();
    if (d) setForm(d);
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return setError("Please enter a project name");
    if (!isValidAddress(form.clientWallet)) return setError("Invalid client wallet address (0x + 40 hex characters)");
    if (!isValidAddress(form.developerWallet)) return setError("Invalid developer wallet address");
    api.saveDraft({ ...form, clientWallet: form.clientWallet.trim(), developerWallet: form.developerWallet.trim() });
    nav({ to: "/confirm" });
  };

  const field = (key: keyof typeof form, label: string, ph: string) => (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      <input className="field" value={form[key]} placeholder={ph}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </label>
  );

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
        <div className="rounded-md bg-muted p-4 text-sm">
          <div className="flex justify-between font-medium"><span>Fixed total</span><span className="font-mono">{TOTAL_ETH} test ETH</span></div>
          {STAGES.map((s, i) => (
            <div key={s.key} className="mt-1 flex justify-between text-muted-foreground">
              <span>Stage {i + 1} · {s.name}</span><span className="font-mono">{s.amount} ETH</span>
            </div>
          ))}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <button type="submit" className="btn btn-primary w-full">Next: Review rules</button>
      </form>
    </Shell>
  );
}
