import { useEffect, useRef, useState } from "react";
import { api, formatWei, type OperationPlan, type OperationReport, type Project } from "@/api/client";

/** Plain-language operations (Agent 3). The backend keeps the intent; this panel only shows it and asks for approval. */
export function OperationAssistant({
  project,
  disabled,
  onProject,
  quickActions = false,
  naturalLanguageEnabled = true,
  language,
}: {
  project: Project;
  disabled: boolean;
  onProject: (project: Project) => void | Promise<void>;
  quickActions?: boolean;
  naturalLanguageEnabled?: boolean;
  language?: "zh" | "en";
}) {
  const zh = language ? language === "zh" : /[一-鿿]/.test(project.name + project.milestones.map(m => m.title).join(" "));
  const unit = zh ? "测试 ETH" : "test ETH";
  const active = useRef(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"plan" | "confirm" | null>(null);
  const [plan, setPlan] = useState<OperationPlan | null>(null);
  const [report, setReport] = useState<OperationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"language" | "button">("language");
  const [refreshFailed, setRefreshFailed] = useState(false);
  const nextMilestone = project.milestones.find(m => !m.paid);
  const executable =
    plan?.status === "readyForConfirmation" && plan.intent && plan.intent.action !== "query";

  useEffect(() => {
    if (!plan?.intent || plan.intent.action === "query") return;
    const milestone = project.milestones.find(m => m.id === plan.intent!.milestoneId);
    if (plan.intent.projectId !== project.id || plan.intent.contractAddress !== project.contractAddress ||
      (plan.intent.action === "deposit" ? project.funded : !project.funded || !milestone || milestone.paid))
      setPlan(null);
  }, [project, plan]);

  const refresh = async () => {
    try { await onProject(await api.getProjectSnapshot(project.id)); }
    catch { setRefreshFailed(true); }
  };
  const prepare = async (kind: "language" | "button", request: () => Promise<OperationPlan>) => {
    if (active.current || disabled || !project.contractAddress) return;
    active.current = true;
    setBusy("plan");
    setSource(kind);
    setPlan(null);
    setReport(null);
    setError(null);
    setRefreshFailed(false);
    try {
      setPlan(await request());
    } catch (e) {
      setError((e as Error).message);
      await refresh();
    } finally {
      active.current = false;
      setBusy(null);
    }
  };
  const ask = () => {
    if (!naturalLanguageEnabled || !message.trim()) return;
    return prepare("language", () => api.planOperation(project.id, message));
  };
  const confirm = async () => {
    if (!plan || !executable || active.current || disabled) return;
    active.current = true;
    setBusy("confirm");
    setError(null);
    setRefreshFailed(false);
    try {
      const done = await api.confirmOperation(project.id, plan.planId);
      setReport(done.report);
      await onProject(done.project);
      setMessage("");
    } catch (e) {
      setError((e as Error).message);
      // The transaction may have completed before the response was lost. Read state; never resend it.
      await refresh();
    } finally {
      setPlan(null);
      active.current = false;
      setBusy(null);
    }
  };

  const review = plan && (
        <div className="mt-4 border-t border-border pt-4 text-sm">
          {source === "language" && <p className="whitespace-pre-wrap break-words">{plan.question ?? plan.summary}</p>}
          {executable && plan.payment && (
            <div className="space-y-2 rounded-md bg-muted p-3" aria-label={zh ? "付款确认信息" : "Payment confirmation details"}>
              <p>{zh ? "金额" : "Amount"}: <strong>{formatWei(plan.payment.amountWei)} {unit}</strong></p>
              <p className="break-all">{zh ? "收款地址" : "Recipient"}: {plan.payment.to}</p>
              {plan.intent?.action === "acceptMilestone" ? (
                <p>{zh ? `确认即表示你已验收第 ${plan.intent.milestoneId} 阶段「${plan.payment.milestoneTitle}」，同意向服务方支付该阶段款项。`
                  : `Confirming accepts milestone #${plan.intent?.milestoneId} "${plan.payment.milestoneTitle}" and releases its payment to the provider.`}</p>
              ) : <p>{zh ? "资金将进入托管合约。本版本没有退款或超时放款；客户不验收，资金可能一直锁定。"
                : "Funds enter escrow. This version has no refund or timeout release; funds may remain locked if the client does not approve."}</p>}
              <p>{zh ? "确认成功后，这笔转账无法撤回。" : "Once confirmed, this transfer cannot be reversed."}</p>
            </div>
          )}
          {executable && (
            <div className="mt-3 flex gap-3">
              <button
                className="btn btn-primary"
                disabled={disabled || busy !== null}
                onClick={confirm}
              >
                {busy === "confirm" ? (zh ? "等待交易回执…" : "Waiting for confirmation…") : source === "button"
                  ? plan.intent?.action === "deposit" ? (zh ? "确认存款" : "Confirm deposit") : (zh ? "确认验收并支付" : "Confirm acceptance and payment")
                  : (zh ? "确认并发送" : "Confirm and send")}
              </button>
              <button
                className="btn btn-outline"
                disabled={busy !== null}
                onClick={() => setPlan(null)}
              >
                {zh ? "取消" : "Cancel"}
              </button>
            </div>
          )}
        </div>
      );

  return (
    <div className="panel mt-4">
      {quickActions && (
        <section aria-label={zh ? "付款操作" : "Payment actions"}>
          <h2 className="font-bold">{zh ? "付款操作" : "Payment actions"}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {zh ? "先核对付款信息，再确认发送。按钮操作无需模型调用。" : "Review the payment before confirming. These buttons make no model request."}
          </p>
          {!project.funded ? (
            <button className="btn btn-primary mt-3"
              disabled={disabled || busy !== null || !project.contractAddress}
              onClick={() => prepare("button", () => api.planKnownOperation(project.id, { action: "deposit" }))}>
              {zh ? "存入" : "Deposit"} {formatWei(project.totalAmountWei)} {unit}
            </button>
          ) : nextMilestone ? (
            <>
              <button className="btn btn-primary mt-3"
                disabled={disabled || busy !== null || !project.contractAddress}
                onClick={() => prepare("button", () => api.planKnownOperation(project.id, { action: "acceptMilestone", milestoneId: nextMilestone.id }))}>
                {zh ? `验收第 ${nextMilestone.id} 阶段并支付` : `Accept milestone ${nextMilestone.id} and pay`} {formatWei(nextMilestone.amountWei)} {unit}
              </button>
              <p className="mt-2 text-sm">{nextMilestone.title}</p>
            </>
          ) : (
            <p className="mt-3 text-success">{zh ? "所有阶段已支付。" : "All milestones paid."}</p>
          )}
          {source === "button" && review}
        </section>
      )}
      {naturalLanguageEnabled ? <section className={quickActions ? "mt-6 border-t border-border pt-4" : ""}>
        <h2 className="font-bold">{zh ? "用自然语言操作" : "Ask in plain language"}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {zh ? "可查询托管状态、存款或验收阶段。提问会调用 Agent 3 模型；资金操作仍需单独确认。"
            : "Asking Agent 3 starts a model request. You can check the escrow, deposit test funds or accept a milestone. Deposits and payments each require your confirmation."}
        </p>
        <label className="field-label mt-4" htmlFor="operation-message">
          {zh ? "你的请求" : "Your request (English or Chinese)"}
        </label>
        <textarea id="operation-message" className="field" rows={2} maxLength={2000}
          placeholder={zh ? "例如：验收第一阶段" : 'For example: "Approve the first milestone"'}
          value={message} disabled={disabled || busy !== null} onChange={e => setMessage(e.target.value)} />
        <button className="btn btn-primary mt-3"
          disabled={disabled || busy !== null || !message.trim() || !project.contractAddress} onClick={ask}>
          {busy === "plan" && source === "language" ? (zh ? "正在询问 Agent 3…" : "Asking Agent 3…") : (zh ? "提问" : "Ask")}
        </button>
        {!project.contractAddress && <p className="mt-1 text-xs text-muted-foreground">{zh ? "请先部署合约" : "Deploy the contract first"}</p>}
        {source === "language" && review}
      </section> : (
        <p className="mt-5 text-sm text-muted-foreground">
          {zh ? "自然语言操作尚未开启，仍可使用上方付款按钮。" : "Plain-language operations are disabled on this backend. The payment buttons remain available."}
        </p>
      )}
      {report && (
        <p
          className={`mt-4 whitespace-pre-wrap break-words text-sm ${report.outcome === "confirmed" ? "text-success" : "text-destructive"}`}
        >
          {report.summary}
        </p>
      )}
      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
      {refreshFailed && <p className="mt-2 text-sm text-destructive">
        {zh ? "尚未刷新链上状态，请先刷新余额和回执再操作。" : "Refresh the project status before trying another payment."}
      </p>}
    </div>
  );
}
