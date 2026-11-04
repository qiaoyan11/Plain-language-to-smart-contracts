import type { ProjectDraft } from "./types";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}
export interface Workspace {
  draft: ProjectDraft;
  messages: ConversationMessage[];
  notes: string;
}
export const SAMPLE_MESSAGE =
  "I'm hiring a developer to build our company website for 0.01 test ETH. Pay 30% when I approve the homepage and 70% when I approve the completed website. I'll deposit the full amount first, and payments must happen in that order.";
export const emptyWorkspace = (): Workspace => ({
  draft: {
    name: "",
    clientWallet: "",
    developerWallet: "",
    milestones: [{ title: "", amountWei: "0" }],
  },
  messages: [],
  notes: "",
});
const KEY = "contract-conversation-v1";
const NOTES = "contract-context-v1:";

// Browser-only notes, never extra fields on the payment/agent wire contracts.
function read<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(sessionStorage.getItem(key) || "null") as T | null;
  } catch {
    return null;
  }
}
export function addMessage(state: Workspace, content: string): Workspace {
  if (!content.trim()) return state;
  const sample = content.trim() === SAMPLE_MESSAGE;
  const draft = sample
    ? {
        ...state.draft,
        name: "Company website",
        milestones: [
          { title: "Homepage accepted", amountWei: "3000000000000000" },
          { title: "Completed website accepted", amountWei: "7000000000000000" },
        ],
      }
    : state.draft;
  return {
    ...state,
    draft,
    messages: [
      ...state.messages,
      { role: "user", content },
      {
        role: "assistant",
        content: sample
          ? "This is a scripted example: I filled in the two payment stages. You can add requirements below or edit the agreement draft. Wallets can wait until the review step."
          : "Your text is saved in this conversation. Automatic interpretation is not connected yet. Please update the payment fields in the agreement draft yourself. Other requirements remain for human review; this version cannot implement refunds, deadlines or automatic acceptance.",
      },
    ],
  };
}
export const workspaceStorage = {
  getWorkspace(): Workspace {
    return read<Workspace>(KEY) || emptyWorkspace();
  },
  saveWorkspace(value: Workspace) {
    sessionStorage.setItem(KEY, JSON.stringify(value));
  },
  clearWorkspace() {
    sessionStorage.removeItem(KEY);
  },
  saveContext(id: string, value: Workspace, specVersion: number) {
    sessionStorage.setItem(NOTES + id, JSON.stringify({ ...value, specVersion }));
  },
  getContext(id: string) {
    return read<Workspace & { specVersion: number }>(NOTES + id);
  },
};
