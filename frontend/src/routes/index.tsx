import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { DraftSummary, draftReady } from "@/components/DraftSummary";
import { DraftConversation, latestDraftQuestion } from "@/components/DraftConversation";
import { useActiveDraft } from "@/hooks/use-active-draft";
import { isChineseDraft } from "@/lib/draft-language";
import { api } from "@/api/client";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Describe your agreement · Accord" }] }),
  component: CreatePage,
});
export function CreatePage() {
  const nav = useNavigate();
  const cache = useQueryClient();
  const { id, selectDraft, query, session } = useActiveDraft();
  const context = useQuery({
    queryKey: ["draft-context"],
    queryFn: api.getDraftContext,
    retry: false,
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
  const occupied = working || session?.busy || query.isFetching;
  const disabled =
    occupied ||
    id === undefined ||
    Boolean(id && !session) ||
    !context.data?.clarificationEnabled ||
    query.isError ||
    Boolean(session?.confirmedProjectId);
  const failure = error || query.error?.message || context.error?.message || session?.lastError;
  const zh = isChineseDraft([
    ...(session?.messages ?? []),
    { content: session?.pendingMessage?.content ?? message },
  ]);
  const language = zh ? "zh" : "en";

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
      setError((caught as Error).message);
      if (current) {
        try {
          await cache.cancelQueries({ queryKey: ["draft", current.id] });
          const latest = await cache.fetchQuery({
            queryKey: ["draft", current.id],
            queryFn: () => api.getDraft(current!.id),
            staleTime: 0,
          });
          if (
            pending.current &&
            latest.revision > pending.current.expectedRevision &&
            !latest.pendingMessage
          ) {
            if (latest.messages.at(-1)?.content === pending.current.content) setMessage("");
            pending.current = null;
          }
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
  return (
    <Shell step={zh ? "描述与补充" : "Describe & refine"}>
      <h1>{zh ? "你想约定什么？" : "What would you like to agree on?"}</h1>
      <p className="intro">
        {zh
          ? "粘贴合同或描述工作与付款方式。逐步回答问题，再单独核对并确认协议。"
          : "Paste your contract or describe the work and payment terms. Answer the questions, then review the agreement before confirming."}
      </p>
      <div className="grid items-start gap-8 md:grid-cols-2">
        <div>
          <DraftConversation session={session} language={language} />
          {session?.confirmedProjectId ? (
            <div className="mt-5 space-y-4">
              <p className="text-sm">
                {zh
                  ? "这份协议已确认。可打开项目生成合约；若需修改条款，请新建协议。"
                  : "This agreement is confirmed. Open the project to generate its contract, or start a new agreement to change the terms."}
              </p>
              <Button
                onClick={() =>
                  nav({ to: "/projects/$id", params: { id: session.confirmedProjectId! } })
                }
              >
                {zh ? "打开已确认项目" : "Open confirmed project"}
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
                {zh ? "描述协议或补充信息" : "Describe your agreement or add a detail"}
              </label>
              <textarea
                id="agreement-message"
                className="agreement-text"
                maxLength={20000}
                value={input}
                onChange={(event) => setMessage(event.target.value)}
                disabled={Boolean(occupied || session?.pendingMessage)}
                placeholder={
                  zh
                    ? "谁来完成工作，要交付什么，何时付款？"
                    : "Who is doing the work, what will they deliver, and when should they be paid?"
                }
              />
              <Button className="mt-3" type="submit" disabled={disabled || !input.trim()}>
                {occupied
                  ? zh
                    ? "正在整理协议…"
                    : "Updating agreement…"
                  : session?.pendingMessage
                    ? zh
                      ? "重试这条消息"
                      : "Retry this message"
                    : zh
                      ? "发送消息"
                      : "Send message"}
                <ArrowUp />
              </Button>
              <p className="mt-3 text-xs text-muted-foreground">
                {zh
                  ? "发送消息会调用 AI，可能产生模型费用。对话和草稿保存在本机服务中。"
                  : "Each message starts an AI request and may incur model costs. Your conversation and draft are saved on this local backend."}
              </p>
              {context.data?.clarificationEnabled && !session?.pendingMessage && (
                <Button
                  className="mt-3"
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    send(
                      zh
                        ? `本次本地测试，请使用 ${context.data.clientWallet} 作为客户钱包，${context.data.developerWallet} 作为服务方钱包。`
                        : `For this local test, use ${context.data.clientWallet} as the client wallet and ${context.data.developerWallet} as the developer wallet.`,
                    )
                  }
                >
                  {zh ? "使用本机测试账户" : "Use local test accounts"}
                </Button>
              )}
            </form>
          )}
          {id !== undefined && id && (
            <Button className="mt-4" variant="link" disabled={working} onClick={startNew}>
              {zh ? "新建协议" : "Start a new agreement"}
            </Button>
          )}
        </div>
        <aside
          className="rounded-lg border border-border p-5"
          aria-label={zh ? "当前协议草稿" : "Current agreement draft"}
        >
          <DraftSummary
            result={session?.result ?? null}
            language={language}
            compactIssues
            primaryQuestionField={latestDraftQuestion(session)?.field}
          />
          {!session?.confirmedProjectId && (
            <div className="mt-6 border-t border-border pt-5">
              <p className="mb-3 text-sm">
                {draftReady(session)
                  ? zh
                    ? "付款规则已整理好，可以核对协议。"
                    : "The payment details are ready for your review."
                  : zh
                    ? "先回答对话中的问题，补齐付款条件后再核对。"
                    : "Resolve the questions and payment conditions before review."}
              </p>
              <Button
                disabled={!draftReady(session) || Boolean(occupied || failure)}
                onClick={() => nav({ to: "/confirm" })}
              >
                {zh ? "核对协议" : "Review agreement"}
              </Button>
            </div>
          )}
        </aside>
      </div>
      {context.data && !context.data.clarificationEnabled && (
        <p className="mt-5 text-sm">
          {zh
            ? "本机尚未启用协议助手，请由项目负责人开启后再开始对话。"
            : "The drafting assistant is disabled on this backend. The project owner can enable it to start this conversation."}
        </p>
      )}
      {failure && (
        <p role="alert" className="mt-5 text-sm text-destructive">
          {failure}
        </p>
      )}
      {query.isError && (
        <p className="mt-2 text-sm">
          {zh
            ? "重启本机服务会清空草稿。如果这份草稿已不可用，请新建协议。"
            : "Local drafts reset when the backend restarts. Start a new agreement if this draft is unavailable."}
        </p>
      )}
      <Button
        variant="link"
        className="mt-4 px-0"
        disabled={working}
        onClick={() => void refresh()}
      >
        {zh ? "刷新状态" : "Refresh status"}
      </Button>
    </Shell>
  );
}
