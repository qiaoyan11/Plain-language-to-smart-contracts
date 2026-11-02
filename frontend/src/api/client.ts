/** Project API v2. All page data access stays here; local chain is the default. */
export const MOCK_MODE = import.meta.env["VITE_API_MODE"] === "mock";
const API_BASE = import.meta.env["VITE_API_BASE"] || "/api";
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Backend request failed");
  return data as T;
}
export interface MilestoneDraft { title: string; amountWei: string }
export interface ProjectDraft {
  name: string; clientWallet: string; developerWallet: string;
  milestones: MilestoneDraft[];
}
export interface Project extends Omit<ProjectDraft, "milestones"> {
  schemaVersion: 2; id: string; totalAmountWei: string;
  milestones: (MilestoneDraft & { id: number; paid: boolean })[];
  contractAddress: string | null; escrowBalanceWei: string; funded: boolean;
  transactions: { action: string; milestoneId?: number; hash: string; blockNumber: number; status: number }[];
  createdAt: string;
}
export type ProjectAction = { action: "deploy" } | { action: "deposit" } | { action: "acceptMilestone"; milestoneId: number };
const MAX_WEI = (1n << 256n) - 1n;
const UNIT = 10n ** 18n;

// Decimal text is converted directly to integer wei, never through floating point.
export function ethToWei(input: string): string {
  const text = input.trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(text) || text.length > 100) throw new Error("Use a positive ETH amount with at most 18 decimal places");
  const [whole = "0", fraction = ""] = text.split(".");
  const wei = BigInt(whole) * UNIT + BigInt(fraction.padEnd(18, "0"));
  if (wei <= 0n || wei > MAX_WEI) throw new Error("Amount must be positive and within the contract limit");
  return wei.toString();
}
export function formatWei(wei: string): string {
  const n = BigInt(wei);
  const fraction = (n % UNIT).toString().padStart(18, "0").replace(/0+$/, "");
  return `${n / UNIT}${fraction ? `.${fraction}` : ""}`;
}
export function totalWei(milestones: MilestoneDraft[]): string {
  if (milestones.length < 1 || milestones.length > 5) throw new Error("Provide 1–5 milestones");
  let total = 0n;
  for (const m of milestones) {
    if (!m.title.trim() || m.title.length > 120) throw new Error("Each milestone needs a title of 1–120 characters");
    if (!/^[1-9][0-9]{0,77}$/.test(m.amountWei)) throw new Error("Invalid milestone amount");
    total += BigInt(m.amountWei);
    if (total > MAX_WEI) throw new Error("Total exceeds the contract limit");
  }
  return total.toString();
}
export function actionBlockReason(p: Project, intent: ProjectAction): string | null {
  if (intent.action === "deploy") return p.contractAddress ? "Contract already deployed" : null;
  if (!p.contractAddress) return "Deploy the contract first";
  if (intent.action === "deposit") return p.funded ? "Funds already deposited" : null;
  const milestone = p.milestones.find(m => m.id === intent.milestoneId);
  if (!milestone) return "Invalid milestone ID";
  if (milestone.paid) return `Stage ${milestone.id} already paid`;
  if (!p.funded) return "No funds deposited yet — cannot pay";
  if (p.milestones.some(m => m.id < milestone.id && !m.paid)) return "Earlier stages must be paid first";
  return null;
}
export function applyAction(p: Project, intent: ProjectAction): Project {
  const reason = actionBlockReason(p, intent);
  if (reason) throw new Error(reason);
  const next: Project = { ...p, milestones: p.milestones.map(m => ({ ...m })) };
  if (intent.action === "deploy") next.contractAddress = randomHex(40);
  if (intent.action === "deposit") { next.funded = true; next.escrowBalanceWei = p.totalAmountWei; }
  if (intent.action === "acceptMilestone") {
    const milestone = next.milestones.find(m => m.id === intent.milestoneId)!;
    next.escrowBalanceWei = (BigInt(next.escrowBalanceWei) - BigInt(milestone.amountWei)).toString();
    milestone.paid = true;
  }
  return next;
}
export function isValidAddress(a: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(a.trim()) && !/^0x0{40}$/i.test(a.trim());
}
// v2 keys isolate old two-stage mock projects and drafts, without deleting them.
const STORE_KEY = "mock-projects-v2";
const DRAFT_KEY = "escrow-draft-v2";
const FAIL_KEY = "mock-simulate-failure";
function randomHex(len: number) {
  let s = "0x";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
function wait(ms = 500) { return new Promise(r => setTimeout(r, ms)); }
function readAll(): Record<string, Project> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch { return {}; }
}
function writeAll(all: Record<string, Project>) { localStorage.setItem(STORE_KEY, JSON.stringify(all)); }
export const api = {
  async getLocalAccounts(): Promise<{ clientWallet: string; developerWallet: string }> { return request("/local-accounts"); },
  getSimulateFailure(): boolean { return typeof window !== "undefined" && localStorage.getItem(FAIL_KEY) === "1"; },
  setSimulateFailure(on: boolean) { localStorage.setItem(FAIL_KEY, on ? "1" : "0"); },
  saveDraft(draft: ProjectDraft) { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); },
  getDraft(): ProjectDraft | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      const draft = JSON.parse(raw) as ProjectDraft;
      totalWei(draft.milestones);
      return draft;
    } catch { return null; }
  },
  async createProject(draft: ProjectDraft): Promise<Project> {
    const totalAmountWei = totalWei(draft.milestones);
    if (!MOCK_MODE) {
      const project = await request<Project>("/projects", draft);
      sessionStorage.removeItem(DRAFT_KEY);
      return project;
    }
    await wait();
    const id = crypto.randomUUID();
    const project: Project = { ...draft, schemaVersion: 2, id, totalAmountWei,
      milestones: draft.milestones.map((m, i) => ({ ...m, id: i + 1, paid: false })),
      contractAddress: null, escrowBalanceWei: "0", funded: false, transactions: [], createdAt: new Date().toISOString() };
    const all = readAll(); all[id] = project; writeAll(all);
    sessionStorage.removeItem(DRAFT_KEY);
    return project;
  },
  async getProject(id: string): Promise<Project | null> {
    if (!MOCK_MODE) return request<Project>(`/projects/${encodeURIComponent(id)}`);
    await wait(100); return readAll()[id] ?? null;
  },
  async runAction(id: string, intent: ProjectAction): Promise<Project> {
    if (!MOCK_MODE) return request<Project>(`/projects/${encodeURIComponent(id)}/actions`, intent);
    const all = readAll(), p = all[id];
    if (!p) throw new Error("Project not found");
    await wait();
    if (api.getSimulateFailure()) throw new Error("Simulated transaction failure; please retry");
    const next = applyAction(p, intent); all[id] = next; writeAll(all); return next;
  },
};
