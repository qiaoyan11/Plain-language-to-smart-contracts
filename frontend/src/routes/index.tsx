import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { ContractUpload } from "@/components/ContractUpload";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { DraftSummary, draftReady } from "@/components/DraftSummary";
import { DraftConversation, latestDraftQuestion } from "@/components/DraftConversation";
import { useActiveDraft } from "@/hooks/use-active-draft";
import { api, reconnectDelay } from "@/api/client";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Describe your agreement · Accord" }] }),
  component: CreatePage,
});
const EXAMPLE =
  "I'm hiring Leo to build a website for my bakery, Golden Crumb, for $1,000. I'll pay 30% when I approve the homepage design and the rest when the finished site takes online orders.";

export function CreatePage() {
  const nav = useNavigate();
  const cache = useQueryClient();
  const { id, selectDraft, query, session } = useActiveDraft();
  const context = useQuery({
    queryKey: ["draft-context"],
    queryFn: api.getDraftContext,
    retry: false,
    refetchOnReconnect: "always",
    refetchInterval: (q) => reconnectDelay(q.state.error),
  });
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const pending = useRef<{
    id: string;
    content: string;
    expectedRevision: number;
    requestKey: string;
  } | null>(null);
  useEffect(() => {
    const sent = pending.current;
    if (
      sent &&
      session?.id === sent.id &&
      session.revision > sent.expectedRevision &&
      !session.pendingMessage
    ) {
      pending.current = null;
      if (session.messages.at(-1)?.content === sent.content) {
        setMessage("");
        setError("");
      }
    }
  }, [session]);
  const occupied = working || session?.busy || query.isFetching;
  const disabled =
    occupied ||
    id === undefined ||
    Boolean(id && !session) ||
    !context.data?.clarificationEnabled ||
    query.isError ||
    Boolean(session?.confirmedProjectId);
  const reconnecting = Boolean(reconnectDelay(query.error) || reconnectDelay(context.error));
  const failure = reconnecting
    ? "Reconnecting to the local server to check your saved draft."
    : error || query.error?.message || context.error?.message || session?.lastError;

  async function refresh() {
    setError("");
    await context.refetch();
    if (id) await query.refetch();
  }
  function startNew() {
    selectDraft(null);
    pending.current = null;
    setMessage("");
    setError("");
  }
  async function send(text: string) {
    if (active.current || disabled || !text.trim()) return;
    active.current = true;
    setWorking(true);
    setError("");
    let current = session;
    try {
      if (!current) {
        current = await api.createDraft();
        cache.setQueryData(["draft", current.id], current);
        selectDraft(current.id);
      }
      await cache.cancelQueries({ queryKey: ["draft", current.id] });
      const retry = current.pendingMessage;
      if (retry) pending.current = { id: current.id, ...retry };
      if (
        !pending.current ||
        pending.current.id !== current.id ||
        pending.current.content !== text
      ) {
        pending.current = {
          id: current.id,
          content: text,
          expectedRevision: current.revision,
          requestKey: crypto.randomUUID(),
        };
      }
      const attempt = pending.current;
      const next = await api.sendDraftMessage(
        current.id,
        attempt.content,
        attempt.expectedRevision,
        attempt.requestKey,
      );
      await cache.cancelQueries({ queryKey: ["draft", current.id] });
      cache.setQueryData(["draft", current.id], next);
      pending.current = null;
      setMessage("");
    } catch (caught) {
      setError(
        reconnectDelay(caught)
          ? "Your message response did not arrive. Check the conversation before sending it again."
          : (caught as Error).message,
      );
      if (current) {
        try {
          await cache.cancelQueries({ queryKey: ["draft", current.id] });
          await cache.fetchQuery({
            queryKey: ["draft", current.id],
            queryFn: () => api.getDraft(current!.id),
            staleTime: 0,
          });
        } catch {
          /* The read error is displayed alongside the saved draft. */
        }
      }
    } finally {
      active.current = false;
      setWorking(false);
    }
  }
  const input = session?.pendingMessage?.content ?? message;
  const walletQuestion = ["clientWallet", "developerWallet"].includes(
    latestDraftQuestion(session)?.field ?? "",
  );
  return (
    <Shell step="Describe & refine" progress={1}>
      <h1>What would you like to agree on?</h1>
      {!session?.messages.length && (
        <>
          <p className="intro">
            Say what the work is and how you will pay, in your own words, or upload a contract you
            already have.
          </p>
          <p className="-mt-5 mb-8 text-sm text-muted-foreground">
            Coming back?{" "}
            <Link to="/projects" className="text-primary underline underline-offset-4">
              Your projects
            </Link>
          </p>
        </>
      )}
      <div className="grid items-start gap-8 md:grid-cols-2">
        <div>
          <DraftConversation session={session} />
          {session?.confirmedProjectId ? (
            <div className="mt-5 space-y-4">
              <p className="text-sm">This agreement is confirmed.</p>
              <Button
                onClick={() =>
                  nav({ to: "/projects/$id", params: { id: session.confirmedProjectId! } })
                }
              >
                Open confirmed project
              </Button>
            </div>
          ) : (
            <form
              className="mt-5"
              onSubmit={(event) => {
                event.preventDefault();
                void send(input);
              }}
            >
              <label htmlFor="agreement-message" className="field-label">
                Describe your agreement or add a detail
              </label>
              <ContractUpload
                disabled={Boolean(occupied || session?.pendingMessage)}
                current={message}
                onText={setMessage}
              >
                <textarea
                  id="agreement-message"
                  className="agreement-text"
                  maxLength={20000}
                  value={input}
                  onChange={(event) => setMessage(event.target.value)}
                  disabled={Boolean(occupied || session?.pendingMessage)}
                  placeholder="Who is doing the work, what will they deliver, and when should they be paid?"
                />
              </ContractUpload>
              {!session?.messages.length && !session?.pendingMessage && !input.trim() && (
                <div>
                  <Button
                    type="button"
                    variant="link"
                    className="px-0"
                    disabled={occupied}
                    onClick={() => setMessage(EXAMPLE)}
                  >
                    Not sure what to write? Fill in an example
                  </Button>
                </div>
              )}
              <Button className="mt-3" type="submit" disabled={disabled || !input.trim()}>
                {occupied
                  ? "Updating agreement…"
                  : session?.pendingMessage
                    ? "Retry this message"
                    : "Send message"}
                <ArrowUp />
              </Button>
              <p className="mt-3 text-xs text-muted-foreground">
                Saved as you go. An AI model reads your messages.
              </p>
              {context.data?.clarificationEnabled && !session?.pendingMessage && walletQuestion && (
                <p className="mt-4 text-sm">
                  This demo uses two built-in test wallets. Choose{" "}
                  <strong>Use local test accounts</strong> to answer the wallet question.
                </p>
              )}
              {context.data?.clarificationEnabled && !session?.pendingMessage && walletQuestion && (
                <Button
                  className="mt-3"
                  type="button"
                  variant={walletQuestion ? "default" : "outline"}
                  disabled={disabled}
                  onClick={() =>
                    send(
                      `For this local test, use ${context.data.clientWallet} as the client wallet and ${context.data.developerWallet} as the provider wallet.`,
                    )
                  }
                >
                  Use local test accounts
                </Button>
              )}
            </form>
          )}
          {id !== undefined && id && (
            <Button className="mt-4" variant="link" disabled={working} onClick={startNew}>
              Start a new agreement
            </Button>
          )}
        </div>
        <aside className="rounded-lg border border-border p-5" aria-label="Current agreement draft">
          <DraftSummary
            result={session?.result ?? null}
            settledTerms={session?.settledTerms}
            compactIssues
            primaryQuestionField={latestDraftQuestion(session)?.field}
          />
          {!session?.confirmedProjectId && (
            <div className="mt-6 border-t border-border pt-5">
              <p className="mb-3 text-sm">
                {draftReady(session)
                  ? "The payment details are ready for your review."
                  : "Resolve the questions and payment conditions before review."}
              </p>
              <Button
                disabled={!draftReady(session) || Boolean(occupied || failure)}
                onClick={() => nav({ to: "/confirm" })}
              >
                Review agreement
              </Button>
            </div>
          )}
        </aside>
      </div>
      {context.data && !context.data.clarificationEnabled && (
        <p className="mt-5 text-sm">
          The drafting assistant is disabled on this backend. The project owner can enable it to
          start this conversation.
        </p>
      )}
      {failure && (
        <p role="alert" className="mt-5 text-sm text-destructive">
          {failure}
        </p>
      )}
      {(id || failure) && (
        <Button
          variant="link"
          className="mt-4 px-0"
          disabled={working}
          onClick={() => void refresh()}
        >
          Refresh status
        </Button>
      )}
    </Shell>
  );
}
