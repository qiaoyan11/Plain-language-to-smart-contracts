import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import type { DraftSession } from "@/api/types";
import {
  condense,
  contractMessage,
  readContractFile,
  unwrapLines,
  type PdfLibrary,
} from "@/lib/contractFile";
import { CreatePage } from "@/routes/index";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => options,
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

const context = {
  clarificationEnabled: true,
  mode: "local-chain" as const,
  clientWallet: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  developerWallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
};
const empty: DraftSession = {
  id: "draft-1",
  revision: 0,
  createdAt: "",
  updatedAt: "",
  messages: [],
  result: null,
  busy: false,
  pendingMessage: null,
  lastError: null,
  confirmedProjectId: null,
};

function openPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CreatePage />
    </QueryClientProvider>,
  );
}
function choose(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(api, "getDraftContext").mockResolvedValue(context);
  vi.spyOn(api, "getDraft").mockResolvedValue(empty);
  vi.spyOn(api, "createDraft").mockResolvedValue(empty);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("uploading a contract", () => {
  it("puts the contract text in the message box for review, without sending it", async () => {
    const send = vi.spyOn(api, "sendDraftMessage");
    openPage();
    await screen.findByRole("button", { name: "Upload a contract (PDF, Word or text)" });
    choose(
      new File(["Logo for my coffee shop, $500, paid when I approve the files."], "brief.txt", {
        type: "text/plain",
      }),
    );
    const box = screen.getByLabelText<HTMLTextAreaElement>(
      "Describe your agreement or add a detail",
    );
    await waitFor(() => expect(box.value).toContain("Contract file: brief.txt."));
    expect(box.value).toContain("Logo for my coffee shop, $500");
    expect(screen.getByText(/Check the text below/)).toBeVisible();
    expect(send).not.toHaveBeenCalled();
  });
  it("explains files it cannot read instead of sending an empty message", async () => {
    openPage();
    await screen.findByRole("button", { name: "Upload a contract (PDF, Word or text)" });
    choose(new File(["binary"], "old-contract.doc"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save it as .docx or PDF");
    choose(new File(["x"], "photo.jpg", { type: "image/jpeg" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Photos of a contract have no text"),
    );
  });
});

describe("reading contract files", () => {
  it("reads a Word contract: paragraphs, a payment table and Chinese text", async () => {
    const bytes = readFileSync(join(__dirname, "fixtures", "contract.docx"));
    const contract = await readContractFile(new File([bytes], "contract.docx"));
    expect(contract.kind).toBe("docx");
    expect(contract.text).toMatch(/^WEBSITE DEVELOPMENT AGREEMENT/);
    expect(contract.text).toContain("Milestone | Amount\nStages 1 and 2 | $8,000");
    expect(contract.text).toContain(
      "乙方完成网站上线并经甲方验收后，甲方支付尾款人民币 16,000 元。",
    );
  });
  it("reads every page of a PDF and reports a scan without text", async () => {
    const pdf =
      (pages: string[][]): (() => Promise<PdfLibrary>) =>
      async () => ({
        getDocument: () => ({
          promise: Promise.resolve({
            numPages: pages.length,
            getPage: async (n: number) => ({
              getTextContent: async () => ({
                items: pages[n - 1]!.map((str) => ({ str, hasEOL: true })),
              }),
            }),
          }),
        }),
      });
    const file = new File(["%PDF-1.7"], "sublease.pdf", { type: "application/pdf" });
    const contract = await readContractFile(file, {
      loadPdf: pdf([["SUBLEASE AGREEMENT", "Rent: $1,200 for December."], ["Deposit: $600."]]),
    });
    expect(contract.pages).toBe(2);
    expect(contract.text).toBe("SUBLEASE AGREEMENT\nRent: $1,200 for December.\n\nDeposit: $600.");
    await expect(readContractFile(file, { loadPdf: pdf([[""], [" "]]) })).rejects.toThrow(
      /probably a scan/,
    );
  });
  it("rejoins lines a PDF wrapped mid-sentence and keeps clauses apart", () => {
    expect(
      unwrapLines([
        "甲方及其监护人已经详细阅读并理解该项目相关内容、注意事项和本",
        "协议有关约定，并自愿报名参加。",
        "第二章 服务内容",
      ]),
    ).toEqual([
      "甲方及其监护人已经详细阅读并理解该项目相关内容、注意事项和本协议有关约定，并自愿报名参加。",
      "第二章 服务内容",
    ]);
  });
  it("keeps every payment clause of a long contract within one message", () => {
    const clauses = Array.from(
      { length: 300 },
      (_, n) => `Clause ${n}: the parties keep information confidential.`,
    );
    clauses.splice(150, 0, "The Client pays $12,000 in three installments.");
    const fitted = condense(clauses.join("\n"), 4000);
    expect(fitted.condensed).toBe(true);
    expect(fitted.text.length).toBeLessThanOrEqual(4000);
    expect(fitted.text).toContain("The Client pays $12,000 in three installments.");
    expect(
      contractMessage({
        name: "msa.pdf",
        kind: "pdf",
        pages: 12,
        text: fitted.text,
        fullLength: 20000,
        condensed: true,
      }),
    ).toMatch(/^Contract file: msa\.pdf, 12 pages\. Long clauses .* were left out/);
  });
});
