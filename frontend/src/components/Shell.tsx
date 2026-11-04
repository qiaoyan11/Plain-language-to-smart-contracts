import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";

export function Shell({ step, children }: { step: string; children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <div className="prototype-label">
        Local development · Test funds only · Conversation guidance is scripted
      </div>
      <header className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-7">
        <Link to="/" className="flex items-center gap-2 font-display text-lg font-semibold">
          <FileText className="size-5 text-primary" />
          Accord
        </Link>
        <Link
          to="/reference-demo"
          className="text-xs text-muted-foreground underline underline-offset-4"
        >
          Reference payment demo
        </Link>
      </header>
      <main className="mx-auto max-w-3xl px-6 pb-20">
        <div className="mb-9 border-t border-border pt-5 text-xs text-muted-foreground">
          Agreement <span className="mx-2">/</span> {step}
        </div>
        {children}
      </main>
      <footer className="mx-auto max-w-3xl border-t border-border px-6 py-5 text-xs leading-relaxed text-muted-foreground">
        Conversation notes stay in this browser tab. Confirmed payment rules go to the local
        backend. No public blockchain is connected.
      </footer>
    </div>
  );
}
export function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border py-4 sm:flex-row sm:justify-between">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span
        className={
          mono ? "min-w-0 break-all text-sm font-mono sm:max-w-[70%]" : "text-sm font-medium"
        }
      >
        {value}
      </span>
    </div>
  );
}
