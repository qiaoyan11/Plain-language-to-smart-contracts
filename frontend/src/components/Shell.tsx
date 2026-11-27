import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";

export function Shell({ step, children }: { step: string; children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <div className="prototype-label">Local test chain · Test funds only</div>
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
        Your conversation and confirmed rules are saved on the local backend. Restarting it clears
        local drafts, projects and test-chain records.
      </footer>
    </div>
  );
}
export function Row({
  label,
  value,
  mono,
  stacked,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  stacked?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-2 border-b border-border py-4 ${stacked ? "" : "sm:flex-row sm:justify-between"}`}
    >
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span
        className={
          mono
            ? `min-w-0 break-all text-sm font-mono ${stacked ? "" : "sm:max-w-[70%]"}`
            : "break-words text-sm font-medium"
        }
      >
        {value}
      </span>
    </div>
  );
}
