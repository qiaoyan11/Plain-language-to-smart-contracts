import type { DraftSession } from "@/api/types";

// Captured from createDrafting with validated, injected Agent 1 results for the
// reported finance-app conversation. This checks UI handoff, not live model extraction.
export const financeAfter = {
  id: "8b38d4db-b1dd-49eb-a45a-50adf7aa9c2c",
  revision: 5,
  createdAt: "2026-11-27T07:34:00.439Z",
  updatedAt: "2026-11-27T07:34:00.442Z",
  messages: [
    {
      role: "user",
      content: "I want build a finance application",
    },
    {
      role: "user",
      content: "0.08",
    },
    {
      role: "user",
      content:
        "Part A need to check whether part B make a good application. the evaluation stage would be functions in application completed by part B. for example, if part B finished market display function, Part A need to pay 0.02, and if part B finished chat bot section, part A pay 0.02, and then is trade signal alert section (0.02), and user UI design 0.02",
    },
    {
      role: "user",
      content: "0.08 ETH in total.",
    },
    {
      role: "user",
      content: "25% of 0.08 ETH will be paid for milstone 1",
    },
  ],
  turns: [
    {
      revision: 1,
      reply: "Project recorded: Finance application.",
      question: {
        field: "totalAmountWei",
        question: "What total amount in ETH have both parties agreed?",
      },
    },
    {
      revision: 2,
      reply: "The total is recorded as 0.08 ETH.",
      question: {
        field: "milestones",
        question: "Which deliverables should be accepted, in payment order?",
      },
    },
    {
      revision: 3,
      reply:
        "Recorded 4 delivery milestones: 1. Market display; 2. Chat bot; 3. Trade signal alert; 4. User UI design. 4 milestones at 0.02 ETH each, for a total of 0.08 ETH.",
      question: {
        field: "clientWallet",
        question: "What wallet address will the client use to fund the contract?",
      },
    },
    {
      revision: 4,
      reply:
        "The draft is unchanged. The question below still needs an answer before confirmation.",
      question: {
        field: "clientWallet",
        question: "What wallet address will the client use to fund the contract?",
      },
    },
    {
      revision: 5,
      reply:
        "The draft is unchanged. The question below still needs an answer before confirmation.",
      question: {
        field: "clientWallet",
        question: "What wallet address will the client use to fund the contract?",
      },
    },
  ],
  result: {
    status: "needsClarification",
    unsupportedTerms: [],
    separateTerms: [],
    draftSpec: {
      schemaVersion: 1,
      projectId: "8b38d4db-b1dd-49eb-a45a-50adf7aa9c2c",
      specVersion: 5,
      name: "Finance application",
      clientWallet: null,
      developerWallet: null,
      milestones: [
        {
          id: 1,
          title: "Market display",
          amountWei: "20000000000000000",
        },
        {
          id: 2,
          title: "Chat bot",
          amountWei: "20000000000000000",
        },
        {
          id: 3,
          title: "Trade signal alert",
          amountWei: "20000000000000000",
        },
        {
          id: 4,
          title: "User UI design",
          amountWei: "20000000000000000",
        },
      ],
      totalAmountWei: "80000000000000000",
      approvalRole: "client",
      refundPolicy: "none",
      deadline: null,
    },
    questions: [
      {
        field: "developerWallet",
        question: "What is the provider wallet?",
      },
      {
        field: "clientWallet",
        question: "What is the client wallet?",
      },
    ],
  },
  busy: false,
  confirmedProjectId: null,
  pendingMessage: null,
  lastError: null,
} satisfies DraftSession;

export const financeBefore: DraftSession = {
  ...financeAfter,
  revision: 4,
  updatedAt: "2026-11-27T07:34:00.442Z",
  messages: financeAfter.messages.slice(0, -1),
  turns: financeAfter.turns.slice(0, -1),
  result: {
    ...financeAfter.result,
    draftSpec: { ...financeAfter.result.draftSpec, specVersion: 4 },
  },
};
