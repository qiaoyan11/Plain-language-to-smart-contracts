import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowUp, FileText } from "lucide-react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { AgreementEditor } from "@/components/AgreementEditor";
import { api, type ProjectDraft } from "@/api/client";
import { addMessage, emptyWorkspace, SAMPLE_MESSAGE, type Workspace } from "@/api/workspace";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Describe your agreement · Accord" }] }),
  component: CreatePage,
});
export function CreatePage() {
  const nav = useNavigate();
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [message, setMessage] = useState(""),
    [editor, setEditor] = useState(false),
    [revision, setRevision] = useState(0),
    [error, setError] = useState("");
  useEffect(() => setWorkspace(api.getWorkspace()), []);
  function store(next: Workspace) {
    api.saveWorkspace(next);
    setWorkspace(next);
  }
  function send(text: string) {
    if (!text.trim()) return;
    try {
      store(addMessage(workspace, text));
      setMessage("");
      setError("");
      if (text.trim() === SAMPLE_MESSAGE) setRevision((n) => n + 1);
    } catch {
      setError("Your browser could not save this conversation. Keep a copy before continuing.");
    }
  }
  function review(draft: ProjectDraft) {
    try {
      store({ ...workspace, draft });
      nav({ to: "/confirm" });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Shell step="Describe & refine">
      <h1>
        What would you like
        <br className="hidden sm:block" /> to agree on?
      </h1>
      <p className="intro">
        Describe the work, paste a contract, or start with an example. You can keep adding details.
      </p>
      <div aria-label="Agreement conversation" role="log" className="space-y-5">
        {workspace.messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "chat-message chat-user" : "chat-message"}>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {m.role === "user" ? "You" : "Draft assistant · scripted guidance"}
            </p>
            <p className="whitespace-pre-wrap break-words text-sm leading-7">{m.content}</p>
          </div>
        ))}
      </div>
      <form
        className="mt-7"
        onSubmit={(e) => {
          e.preventDefault();
          send(message);
        }}
      >
        <label htmlFor="agreement-message" className="sr-only">
          Describe your agreement or add a detail
        </label>
        <textarea
          id="agreement-message"
          className="agreement-text"
          maxLength={20000}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={
            workspace.messages.length
              ? "Add a requirement, correction, or another part of your contract…"
              : "I'm hiring a developer to build our website…"
          }
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={() => send(SAMPLE_MESSAGE)}>
            Try a scripted example
          </Button>
          <Button type="submit" disabled={!message.trim()}>
            Add to agreement
            <ArrowUp />
          </Button>
        </div>
      </form>
      <details
        className="agreement-summary mt-8"
        open={editor}
        onToggle={(e) => setEditor(e.currentTarget.open)}
      >
        <summary className="flex items-center gap-2 text-sm font-medium">
          <FileText className="size-4" />
          Agreement draft · review payment fields
        </summary>
        <div className="mt-6">
          <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
            Automatic extraction is not connected yet. Edit the payment fields below; your
            conversation is preserved separately. Wallets are added on the next page.
          </p>
          <label className="mb-7 block">
            <span className="field-label">Additional contract details · human review only</span>
            <textarea
              className="field min-h-28"
              maxLength={20000}
              value={workspace.notes}
              onChange={(e) => {
                try {
                  store({ ...workspace, notes: e.target.value });
                } catch {
                  setError("Could not save additional details.");
                }
              }}
              placeholder="Source code handover, design requirements, maintenance…"
            />
          </label>
          <AgreementEditor
            key={revision}
            initial={workspace.draft}
            wallets={false}
            onSave={review}
            submitLabel="Review agreement"
          />
        </div>
      </details>
      {!editor && (
        <Button variant="link" className="mt-4 px-0" onClick={() => setEditor(true)}>
          Edit payment details manually
        </Button>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}
    </Shell>
  );
}
