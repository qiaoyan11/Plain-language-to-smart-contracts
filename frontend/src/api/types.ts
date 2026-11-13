export type Wei = string;

export interface MilestoneDraft {
  title: string;
  amountWei: Wei;
}

export interface ProjectDraft {
  name: string;
  clientWallet: string;
  developerWallet: string;
  milestones: MilestoneDraft[];
}

export interface Project extends Omit<ProjectDraft, "milestones"> {
  schemaVersion: 2;
  id: string;
  createdAt: string;
  totalAmountWei: Wei;
  escrowBalanceWei: Wei;
  contractAddress: string | null;
  funded: boolean;
  milestones: Array<
    MilestoneDraft & {
      id: number;
      paid: boolean;
    }
  >;
  transactions: Array<{
    action: string;
    milestoneId?: number;
    hash: string;
    blockNumber: number;
    status: number;
  }>;
}

export type ProjectAction =
  { action: "deploy" } | { action: "deposit" } | { action: "acceptMilestone"; milestoneId: number };

export interface ConfirmedSpec {
  schemaVersion: 1;
  projectId: string;
  specVersion: number;
  name: string;
  clientWallet: string;
  developerWallet: string;
  milestones: Array<{
    id: number;
    title: string;
    amountWei: Wei;
  }>;
  totalAmountWei: Wei;
  approvalRole: "client";
  refundPolicy: "none";
  deadline: null;
}

export type DraftSpec = Omit<
  ConfirmedSpec,
  "clientWallet" | "developerWallet" | "milestones" | "totalAmountWei"
> & {
  clientWallet: string | null;
  developerWallet: string | null;
  milestones: Array<{
    id: number;
    title: string;
    amountWei: Wei | null;
  }>;
  totalAmountWei: Wei | null;
};

export interface ConfirmationRecord {
  projectId: string;
  specVersion: number;
  confirmationId: string;
  confirmedAt: string;
}

export interface ClarifyInput {
  message: string;
  history: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  draftSpec: DraftSpec | null;
}

export interface ClarifyResult {
  status: "needsClarification" | "readyForConfirmation" | "unsupported";
  draftSpec: DraftSpec;
  questions: Array<{
    field: string;
    question: string;
  }>;
  unsupportedTerms: string[];
}

export interface BuildSettings {
  evmVersion: "paris";
  optimizer: { enabled: true; runs: 200 };
}

export interface SourceBundle {
  projectId: string;
  specVersion: number;
  sources: Record<string, string>;
  entryFile: string;
  entryContract: string;
  compilerVersion: "0.8.28";
  buildSettings: BuildSettings;
  dependencies: [];
  sourceHash: string;
}

export interface Artifact {
  abi: unknown[];
  bytecode: string;
  compilerVersion: "0.8.28";
  buildSettings: BuildSettings;
  sourceHash: string;
  constructorTypes: ["address", "address", "uint256[]"];
}

export interface ValidationReport {
  reportId: string;
  projectId: string;
  specVersion: number;
  sourceHash: string;
  suiteVersion: string;
  mode: "development";
  status: "passed" | "failed" | "toolError";
  checks: Array<{
    name: "compilation" | "staticAnalysis" | "clauseTests";
    status: "passed" | "failed" | "skipped" | "toolError";
    findings: Array<{
      code: string;
      severity: string;
      message: string;
      file: string | null;
      line: number | null;
    }>;
  }>;
  artifact: Artifact | null;
}

export interface GenerateInput {
  spec: ConfirmedSpec;
  confirmation: ConfirmationRecord;
  runConfig: {
    validationMode: "none" | "development";
    maxRepairs: number;
    feedbackSetting: "baseline" | "A" | "B" | "C";
    model: string;
  };
}

export interface GenerateResult {
  status: "generated" | "validated" | "failed" | "toolError";
  sourceBundle: SourceBundle | null;
  validationReport: ValidationReport | null;
  attempts: Array<{
    attempt: number;
    sourceHash: string;
    reportId: string | null;
    feedbackUsed: string[];
  }>;
}

export interface DeploymentRecord {
  chainId: number;
  contractAddress: string;
  abi: unknown[];
  sourceHash: string;
  specVersion: number;
}

export interface PlanInput {
  message: string;
  projectId: string;
  deployment: DeploymentRecord;
  snapshot: Project;
}

export interface PlanResult {
  status: "needsClarification" | "readyForConfirmation" | "blocked";
  question: string | null;
  intent: {
    projectId: string;
    chainId: number;
    contractAddress: string;
    action: "query" | "deposit" | "acceptMilestone";
    milestoneId: number | null;
  } | null;
  summary: string;
}

export interface AgreementContext {
  interfaceVersion: 1;
  spec: ConfirmedSpec;
  confirmation: ConfirmationRecord | null;
  latestRunId: string | null;
  generationEnabled: boolean;
  generatedDeploymentEnabled: boolean;
  operationsEnabled?: boolean;
  deployment?:
    | (Omit<DeploymentRecord, "abi"> & {
        kind: "generated" | "reference";
        runId: string | null;
      })
    | null;
}
export interface GenerationRun {
  schemaVersion: 1;
  id: string;
  projectId: string;
  specVersion: number;
  confirmationId: string;
  status: "running" | "completed" | "error" | "obsolete";
  createdAt: string;
  finishedAt: string | null;
  result: GenerateResult | null;
  error: { code: "GENERATION_TIMEOUT" | "GENERATION_TOOL_ERROR"; message: string } | null;
  generatedDeploymentEnabled: boolean;
}
