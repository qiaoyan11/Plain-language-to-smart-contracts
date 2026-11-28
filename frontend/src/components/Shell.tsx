import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { api } from "@/api/client";
import { Check } from "lucide-react";

const FLOW = ["Describe", "Confirm", "Set up contract", "Fund & pay"] as const;

/** The four stages of an agreement, so a first-time user can see where they are and what comes next. */
function FlowSteps({ current, complete }: { current: number; complete: boolean }) {
  return (
    <ol aria-label="Agreement progress" className="flex flex-wrap gap-2 text-xs font-medium">
      {FLOW.map((label, index) => {
        const number = index + 1;
        const done = complete || number < current;
        const active = !complete && number === current;
        return (
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            className={`pill ${active ? "pill-active" : done ? "pill-info" : ""}`}
          >
            <span aria-hidden="true">{done ? "✓" : number}</span>
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
      <header className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-4 px-6 py-7">
        <Link
          to="/"
          className="flex items-center gap-2.5 font-display text-lg font-bold tracking-tight"
        >
          <span className="brand-mark" aria-hidden="true">
            <Check className="size-4" strokeWidth={2.6} />
          </span>
          Accord
        </Link>
        <nav aria-label="Main" className="flex items-center gap-5 text-sm">
          <span
            className="network-badge"
            title="Contracts run on a test network. Amounts are test ETH; no real money moves."
          >
            Test network
          </span>
          <Link
            to="/projects"
            className="font-semibold text-primary hover:underline underline-offset-4"
          >
            Your projects
          </Link>
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-6 pb-20">
        <div className="mb-8">
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
          Accord runs on a test network: amounts are test ETH and no real money moves. Contracts are
          written by AI and checked automatically; they have not had a professional security audit.
        </p>
        <SignOut />
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

/** Shown only on a hosted site, where an access key opened this browser session. */
function SignOut() {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    let current = true;
    api
      .getSession()
      .then((session) => current && setSignedIn(session.signedIn))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  if (!signedIn) return null;
  return (
    <form method="post" action="/access/sign-out">
      <button type="submit" className="underline underline-offset-4">
        Sign out of this browser
      </button>
    </form>
  );
}
