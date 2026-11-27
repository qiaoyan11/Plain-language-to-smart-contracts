import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";

const FLOW = ["Describe", "Confirm", "Set up contract", "Fund & pay"] as const;

/** The four stages of an agreement, so a first-time user can see where they are and what comes next. */
function FlowSteps({ current, complete }: { current: number; complete: boolean }) {
  return (
    <ol aria-label="Agreement progress" className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
      {FLOW.map((label, index) => {
        const number = index + 1;
        const done = complete || number < current;
        const active = !complete && number === current;
        return (
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            className={`flex items-center gap-2 ${active ? "font-semibold text-foreground" : done ? "text-primary" : "text-muted-foreground"}`}
          >
            <span
              aria-hidden="true"
              className={`flex size-5 items-center justify-center rounded-full border text-[10px] ${active ? "border-foreground" : done ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
            >
              {done ? "✓" : number}
            </span>
            {label}
            {done && <span className="sr-only">(done)</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function Shell({
  step,
  progress,
  complete = false,
  children,
}: {
  step: string;
  /** 1–4 for pages inside the agreement flow; omit elsewhere. */
  progress?: number;
  complete?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <div className="prototype-label">
        Local test-chain demo · Built-in test accounts sign automatically · No real wallet or money
      </div>
      <header className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-4 px-6 py-7">
        <Link to="/" className="flex items-center gap-2 font-display text-lg font-semibold">
          <FileText className="size-5 text-primary" />
          Accord
        </Link>
        <nav aria-label="Main" className="flex items-center gap-5 text-sm">
          <Link to="/projects" className="font-medium text-primary underline underline-offset-4">
            Your projects
          </Link>
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-6 pb-20">
        <div className="mb-9 border-t border-border pt-5">
          {progress ? (
            <FlowSteps current={progress} complete={complete} />
          ) : (
            <span className="sr-only">{step}</span>
          )}
        </div>
        {children}
      </main>
      <footer className="mx-auto max-w-3xl space-y-2 border-t border-border px-6 py-5 text-xs leading-relaxed text-muted-foreground">
        <p>
          This local demo saves drafts, confirmed rules, checks and test-chain receipts on this
          computer. After a restart, open Your projects or the same project link to continue.
        </p>
        <p>
          For developers:{" "}
          <Link to="/reference-demo" className="underline underline-offset-4">
            reference payment demo
          </Link>{" "}
          with a handwritten contract and no AI.
        </p>
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
