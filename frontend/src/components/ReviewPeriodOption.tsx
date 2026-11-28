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
    <div className="-mt-3 mb-6 text-sm text-muted-foreground" data-testid="review-option">
      {on ? (
        <p>
          A payment the client does not answer is released after the review.{" "}
          <button
            className="underline underline-offset-2 disabled:opacity-50"
            disabled={busy || disabled}
            onClick={() => void send(REMOVE_REVIEW_MESSAGE)}
          >
            Turn this off
          </button>
        </p>
      ) : (
        <p>
          Optional:{" "}
          <button
            className="text-left underline underline-offset-2 disabled:opacity-50"
            disabled={busy || disabled}
            onClick={() => void send(ADD_REVIEW_MESSAGE)}
          >
            release a payment automatically if the client does not answer within 14 days of a
            delivery
          </button>
        </p>
      )}
      {busy && (
        <p className="mt-1" aria-live="polite">
          Updating the agreement…
        </p>
      )}
      {error && <p className="mt-1 text-destructive">{error}</p>}
    </div>
  );
}
