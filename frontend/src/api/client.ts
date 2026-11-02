/**
 * 统一数据层（模拟模式）。
 * 以后接入真实后端时，只需替换本文件中的实现，页面组件无需改动。
 */

export const MOCK_MODE = import.meta.env.VITE_API_MODE === "mock";
const API_BASE = import.meta.env.VITE_API_BASE || "/api";
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

export const TOTAL_ETH = 0.01;
export const STAGES = [
  { key: "stage1", name: "Homepage complete", amount: 0.003 },
  { key: "stage2", name: "Full site complete", amount: 0.007 },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];

export interface ProjectDraft {
  name: string;
  clientWallet: string;
  developerWallet: string;
}

export interface Project extends ProjectDraft {
  id: string;
  totalEth: number;
  contractAddress: string | null;
  escrowBalance: number;
  deposited: boolean;
  paid: Record<StageKey, boolean>;
  transactions?: { action: string; hash: string; blockNumber: number; status: number }[];
  createdAt: string;
}

export type ActionKind = "deploy" | "deposit" | "stage1" | "stage2";

const STORE_KEY = "mock-projects";
const DRAFT_KEY = "mock-draft";
const FAIL_KEY = "mock-simulate-failure";

// ---------- 规则（纯函数，可测试） ----------
export function actionBlockReason(p: Project, action: ActionKind): string | null {
  switch (action) {
    case "deploy":
      return p.contractAddress ? "Contract already deployed" : null;
    case "deposit":
      if (!p.contractAddress) return "Deploy the contract first";
      return p.deposited ? "Funds already deposited" : null;
    case "stage1":
      if (p.paid.stage1) return "Stage 1 already paid";
      if (!p.deposited) return "No funds deposited yet — cannot pay";
      return null;
    case "stage2":
      if (p.paid.stage2) return "Stage 2 already paid";
      if (!p.deposited) return "No funds deposited yet — cannot pay";
      if (!p.paid.stage1) return "Stage 1 must be paid first";
      return null;
  }
}

export function applyAction(p: Project, action: ActionKind): Project {
  const reason = actionBlockReason(p, action);
  if (reason) throw new Error(reason);
  const next: Project = { ...p, paid: { ...p.paid } };
  if (action === "deploy") next.contractAddress = randomHex(40);
  if (action === "deposit") {
    next.deposited = true;
    next.escrowBalance = TOTAL_ETH;
  }
  if (action === "stage1" || action === "stage2") {
    const stage = STAGES.find((s) => s.key === action)!;
    next.paid[action] = true;
    next.escrowBalance = round(next.escrowBalance - stage.amount);
  }
  return next;
}

export function isValidAddress(a: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(a.trim());
}

// ---------- 模拟存储 ----------
function round(n: number) {
  return Math.round(n * 1e6) / 1e6;
}
function randomHex(len: number) {
  let s = "0x";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
function wait(ms = 1200) {
  return new Promise((r) => setTimeout(r, ms));
}
function readAll(): Record<string, Project> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
  } catch {
    return {};
  }
}
function writeAll(all: Record<string, Project>) {
  localStorage.setItem(STORE_KEY, JSON.stringify(all));
}

// ---------- 对外 API ----------
export const api = {
  async getLocalAccounts(): Promise<{clientWallet: string; developerWallet: string}> {
    return request("/local-accounts");
  },
  /** 模拟失败开关：默认关闭（操作默认成功） */
  getSimulateFailure(): boolean {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(FAIL_KEY) === "1";
  },
  setSimulateFailure(on: boolean) {
    localStorage.setItem(FAIL_KEY, on ? "1" : "0");
  },
  saveDraft(draft: ProjectDraft) {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  },
  getDraft(): ProjectDraft | null {
    if (typeof window === "undefined") return null;
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as ProjectDraft) : null;
  },
  async createProject(draft: ProjectDraft): Promise<Project> {
    if (!MOCK_MODE) {
      const project = await request<Project>("/projects", draft);
      sessionStorage.removeItem(DRAFT_KEY);
      return project;
    }
    await wait(800);
    const id = Math.random().toString(36).slice(2, 10);
    const project: Project = {
      ...draft,
      id,
      totalEth: TOTAL_ETH,
      contractAddress: null,
      escrowBalance: 0,
      deposited: false,
      paid: { stage1: false, stage2: false },
      createdAt: new Date().toISOString(),
    };
    const all = readAll();
    all[id] = project;
    writeAll(all);
    sessionStorage.removeItem(DRAFT_KEY);
    return project;
  },
  async getProject(id: string): Promise<Project | null> {
    if (!MOCK_MODE) return request<Project>(`/projects/${encodeURIComponent(id)}`);
    await wait(200);
    return readAll()[id] ?? null;
  },
  async runAction(id: string, action: ActionKind): Promise<Project> {
    if (!MOCK_MODE) return request<Project>(`/projects/${encodeURIComponent(id)}/actions`, { action });
    const all = readAll();
    const p = all[id];
    if (!p) throw new Error("Project not found");
    const reason = actionBlockReason(p, action);
    if (reason) throw new Error(reason);
    await wait(1500);
    if (api.getSimulateFailure()) throw new Error("Simulated transaction failure: network congested, please retry");
    const next = applyAction(p, action);
    all[id] = next;
    writeAll(all);
    return next;
  },
};
