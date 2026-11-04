import { useState } from "react";
import { Plus, Trash2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type ProjectDraft } from "@/api/client";
export function AgreementEditor({
  initial,
  onSave,
  onCancel,
  submitLabel = "Review agreement",
  wallets = true,
  onDirty,
}: {
  initial: ProjectDraft;
  onSave: (d: ProjectDraft) => void;
  onCancel?: () => void;
  submitLabel?: string;
  wallets?: boolean;
  onDirty?: () => void;
}) {
  const [name, setName] = useState(initial.name),
    [client, setClient] = useState(initial.clientWallet),
    [developer, setDeveloper] = useState(initial.developerWallet);
  const [milestones, setMilestones] = useState(
      initial.milestones.map((m) => ({ title: m.title, amount: api.formatEth(m.amountWei) })),
    ),
    [error, setError] = useState("");
  function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const d = {
        name,
        clientWallet: client,
        developerWallet: developer,
        milestones: milestones.map((m) => ({ title: m.title, amountWei: api.parseEth(m.amount) })),
      };
      const reason = api.validateDraft(d, wallets);
      if (reason) throw new Error(reason);
      onSave(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <form onChange={() => onDirty?.()} onSubmit={submit} className="space-y-7">
      <label className="block">
        <span className="field-label">Project name</span>
        <input
          className="field"
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Company website"
        />
      </label>
      {wallets && (
        <section className="space-y-4">
          <h2>Participants</h2>
          <label className="block">
            <span className="field-label">Client wallet · approves payments</span>
            <input
              className="field font-mono"
              value={client}
              onChange={(e) => setClient(e.target.value)}
              placeholder="0x…"
            />
          </label>
          <label className="block">
            <span className="field-label">Developer wallet · receives payments</span>
            <input
              className="field font-mono"
              value={developer}
              onChange={(e) => setDeveloper(e.target.value)}
              placeholder="0x…"
            />
          </label>
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            onClick={async () => {
              try {
                const a = await api.getLocalAccounts();
                setClient(a.clientWallet);
                setDeveloper(a.developerWallet);
                onDirty?.();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Use local test accounts
          </Button>
        </section>
      )}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2>Ordered milestones</h2>
          <span className="text-xs text-muted-foreground">{milestones.length} / 5</span>
        </div>
        {milestones.map((m, i) => (
          <div key={i} className="milestone-edit">
            <span className="text-sm text-muted-foreground">{i + 1}.</span>
            <label className="min-w-0">
              <span className="sr-only">Milestone {i + 1} title</span>
              <input
                className="field"
                maxLength={120}
                value={m.title}
                placeholder="Milestone title"
                onChange={(e) =>
                  setMilestones(
                    milestones.map((x, j) => (i === j ? { ...x, title: e.target.value } : x)),
                  )
                }
              />
            </label>
            <label>
              <span className="sr-only">Milestone {i + 1} amount in ETH</span>
              <input
                className="field"
                inputMode="decimal"
                value={m.amount}
                placeholder="Test ETH"
                onChange={(e) =>
                  setMilestones(
                    milestones.map((x, j) => (i === j ? { ...x, amount: e.target.value } : x)),
                  )
                }
              />
            </label>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title={`Remove milestone ${i + 1}`}
              aria-label={`Remove milestone ${i + 1}`}
              disabled={milestones.length === 1}
              onClick={() => {
                setMilestones(milestones.filter((_, j) => i !== j));
                onDirty?.();
              }}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={milestones.length >= 5}
            onClick={() => {
              setMilestones([...milestones, { title: "", amount: "" }]);
              onDirty?.();
            }}
          >
            <Plus />
            Add milestone
          </Button>
          <span className="text-xs text-muted-foreground">Amounts in test ETH</span>
        </div>
      </section>
      <div className="flex justify-between border-y border-border py-4 text-sm">
        <span>Total</span>
        <span className="font-mono">
          {(() => {
            try {
              return (
                api.formatEth(
                  milestones.reduce((n, m) => n + BigInt(api.parseEth(m.amount)), 0n).toString(),
                ) + " test ETH"
              );
            } catch {
              return "—";
            }
          })()}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit">
          {submitLabel}
          <ArrowRight />
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
