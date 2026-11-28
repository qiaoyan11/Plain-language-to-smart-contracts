import { useState } from "react";
import { api } from "@/api/client";
import type { DraftSession } from "@/api/types";

/** Sent as the user's own message, so Agent 1 records it like any other agreed term. */
export const ADD_REVIEW_MESSAGE =
  "If the client does not respond within 14 days after a delivery, release that payment automatically.";
export const REMOVE_REVIEW_MESSAGE =
  "No automatic payment after a review period: the client approves every payment.";

/**
 * The optional review period on the review page (docs/REVIEW_PERIOD_V2.md). Off unless the
 * agreement says so; one click adds the common 14-day rule, or removes it again.
 */
export function ReviewPeriodOption({
  session,
  disabled = false,
  onSession,
}: {
  session: DraftSession;
  disabled?: boolean;
  onSession: (session: DraftSession) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const spec = session.result?.draftSpec;
  if (!spec || session.confirmedProjectId) return null;
  const on = Boolean(spec.reviewPeriodSeconds);
  async function send(text: string) {
    if (busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      onSession(
        await api.sendDraftMessage(session.id, text, session.revision, crypto.randomUUID()),
      );
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="-mt-3 mb-6 rounded-md border border-border p-3 text-sm"
      data-testid="review-option"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1">
          {on
            ? "A payment the client does not answer is released when the review ends."
            : "Optional: release a payment automatically if the client does not answer within 14 days of a delivery."}
        </p>
        <button
          className="btn btn-outline shrink-0"
          disabled={busy || disabled}
          onClick={() => void send(on ? REMOVE_REVIEW_MESSAGE : ADD_REVIEW_MESSAGE)}
        >
          {busy ? "Updating…" : on ? "Remove" : "Add"}
        </button>
      </div>
      {error && <p className="mt-2 text-destructive">{error}</p>}
    </div>
  );
}
