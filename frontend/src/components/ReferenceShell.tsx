import { useEffect, useState, type ReactNode } from "react";
import { api, MOCK_MODE } from "@/api/client";
import { Link } from "@tanstack/react-router";

export function Shell({ step, children }: { step: string; children: ReactNode }) {
  const [fail, setFail] = useState(false);
  useEffect(() => setFail(api.getSimulateFailure()), []);
  const toggle = () => {
    api.setSimulateFailure(!fail);
    setFail(!fail);
  };
  return (
    <div className="min-h-screen">
      <div className="mock-banner">
        <span className="mock-pill">{MOCK_MODE ? "MOCK MODE" : "LOCAL TEST CHAIN"}</span>
        <span>{MOCK_MODE ? "Mock data only — no blockchain connected" : "Real contract execution on a local EVM · demo accounts auto-sign · no real funds · restart resets data"}</span>
        {MOCK_MODE && <label className="mock-toggle">
          <input type="checkbox" checked={fail} onChange={toggle} />
          Simulate failure: {fail ? "ON" : "OFF"}
        </label>}
      </div>
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-6">
        <Link to="/" className="font-display text-xl font-bold">
          Escrow<span className="text-primary">.</span>
        </Link>
        <span className="font-mono text-xs text-muted-foreground">{step}</span>
      </header>
      <main className="mx-auto max-w-3xl px-6 pb-20">{children}</main>
    </div>
  );
}

export function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 sm:flex-row sm:justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={mono ? "break-all font-mono text-sm" : "font-medium"}>{value}</span>
    </div>
  );
}
