/**
 * Read an uploaded contract in the browser and return its text for the agreement assistant.
 *
 * The file never leaves the user's computer: only the extracted text is sent, as an ordinary
 * conversation message the user can read and edit first. Word files are unzipped with the
 * browser's own DecompressionStream; PDFs use pdf.js, loaded from a CDN only when a PDF is
 * chosen. Scanned PDFs and photos have no text layer and are reported as such.
 */

export type ContractKind = "pdf" | "docx" | "text";

export interface ContractText {
  name: string;
  kind: ContractKind;
  /** The text to send: the whole document, or its payment-related parts when it is long. */
  text: string;
  /** Characters in the whole extracted document. */
  fullLength: number;
  /** True when long legal sections were left out to fit one message. */
  condensed: boolean;
  pages?: number | undefined;
}

export class ContractFileError extends Error {}

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** The assistant accepts 20,000 characters per message; leave room for the file line. */
export const MAX_TEXT_CHARS = 19_000;
const PDFJS_VERSION = "4.10.38";
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;

export const ACCEPTED =
  ".pdf,.docx,.txt,.md,.text,application/pdf,text/plain,text/markdown," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The file's bytes; FileReader covers environments whose File has no arrayBuffer(). */
function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsArrayBuffer(file);
  });
}

function extension(name: string) {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1]!.toLowerCase() : "";
}

// ---------------------------------------------------------------- Word (.docx)

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(new Uint8Array(data)).body!.pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The entries of a zip archive, read from its central directory. */
async function unzip(bytes: Uint8Array, wanted: (name: string) => boolean) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0)
    throw new ContractFileError("This Word file looks damaged. Save it again as .docx or PDF.");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + compressed);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, await inflateRaw(raw));
  }
  return files;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const value =
        code[1] === "x" || code[1] === "X"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Paragraph text of WordprocessingML: runs, tabs and line breaks; table cells joined by " | ". */
export function wordXmlToText(xml: string) {
  const body = xml.replace(/<w:(?:del|instrText)\b[\s\S]*?<\/w:(?:del|instrText)>/g, "");
  const rows: string[] = [];
  for (const table of body.split(/(<w:tbl>[\s\S]*?<\/w:tbl>)/)) {
    if (table.startsWith("<w:tbl>")) {
      for (const row of table.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []) {
        const cells = (row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []).map((cell) =>
          paragraphs(cell).join(" ").trim(),
        );
        if (cells.some(Boolean)) rows.push(cells.join(" | "));
      }
    } else {
      rows.push(...paragraphs(table));
    }
  }
  return rows.join("\n");
}

const RUN_PARTS =
  /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:t\b[^>]*\/>|<w:(tab)\b[^>]*\/>|<w:(br|cr)\b[^>]*\/>/g;

/** The visible text of each paragraph: text runs in order, with tabs and line breaks. */
function paragraphs(xml: string) {
  return (xml.match(/<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g) ?? []).map((p) => {
    let text = "";
    for (const part of p.matchAll(RUN_PARTS))
      text += part[1] !== undefined ? decodeXml(part[1]) : part[2] ? "\t" : part[3] ? "\n" : "";
    return text;
  });
}

async function readDocx(bytes: Uint8Array) {
  const files = await unzip(bytes, (name) =>
    /^word\/(document|footnotes|endnotes)\.xml$/.test(name),
  );
  const document = files.get("word/document.xml");
  if (!document) throw new ContractFileError("This file is not a Word document (.docx).");
  const decoder = new TextDecoder();
  const parts = [wordXmlToText(decoder.decode(document))];
  for (const extra of ["word/footnotes.xml", "word/endnotes.xml"]) {
    const data = files.get(extra);
    if (data) parts.push(wordXmlToText(decoder.decode(data)));
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------- PDF

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}
export interface PdfLibrary {
  GlobalWorkerOptions?: { workerSrc: string };
  getDocument(source: Record<string, unknown>): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItem[] }> }>;
    }>;
  };
}

let pdfLibrary: Promise<PdfLibrary> | null = null;
/** pdf.js is large and only needed for PDFs, so it is fetched the first time one is read. */
export function loadPdfLibrary(): Promise<PdfLibrary> {
  pdfLibrary ??= import(/* @vite-ignore */ `${PDFJS_BASE}/build/pdf.min.mjs`)
    .then((module: PdfLibrary) => {
      if (module.GlobalWorkerOptions)
        module.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.min.mjs`;
      return module;
    })
    .catch(() => {
      pdfLibrary = null;
      throw new ContractFileError(
        "The PDF reader could not be loaded. Check the internet connection, or paste the contract text instead.",
      );
    });
  return pdfLibrary;
}

async function readPdf(bytes: Uint8Array, load: () => Promise<PdfLibrary>) {
  const pdfjs = await load();
  let document;
  try {
    document = await pdfjs.getDocument({
      data: bytes,
      cMapUrl: `${PDFJS_BASE}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
      isEvalSupported: false,
    }).promise;
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    throw new ContractFileError(
      /password/i.test(message)
        ? "This PDF is password-protected. Remove the password, or paste the contract text instead."
        : "This PDF could not be opened. Save it again, or paste the contract text instead.",
    );
  }
  const pages: string[] = [];
  for (let n = 1; n <= document.numPages; n++) {
    const content = await (await document.getPage(n)).getTextContent();
    let line = "";
    const lines: string[] = [];
    for (const item of content.items) {
      line += item.str ?? "";
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      }
    }
    if (line) lines.push(line);
    pages.push(unwrapLines(withoutPageNumbers(lines)).join("\n"));
  }
  return { text: joinPages(pages), pages: document.numPages };
}

const PAGE_NUMBER =
  /^\s*(?:(?:page\s+)?\d{1,3}(?:\s+of\s+\d{1,3})?|[-\u2014]\s*\d{1,3}\s*[-\u2014]|\u7b2c\s*\d{1,3}\s*\u9875(?:\s*\u5171\s*\d{1,3}\s*\u9875)?)\s*$/i;

/** A page's lines without the page number printed at its top or bottom. */
export function withoutPageNumbers(lines: string[]) {
  const kept = [...lines];
  while (kept.length && (!kept[0]!.trim() || PAGE_NUMBER.test(kept[0]!))) kept.shift();
  while (kept.length && (!kept.at(-1)!.trim() || PAGE_NUMBER.test(kept.at(-1)!))) kept.pop();
  return kept;
}

/** Pages joined by a blank line, except where a sentence runs on to the next page. */
export function joinPages(pages: string[]) {
  return pages.reduce((text, page) => {
    if (!text) return page;
    if (!page) return text;
    const runsOn = !ENDS_SENTENCE.test(text.trimEnd()) && /^[a-z\u3000-\u9fff]/.test(page);
    const cjk = CJK.test(text.trimEnd().slice(-1)) && CJK.test(page[0]!);
    return text + (runsOn ? (cjk ? "" : " ") : "\n\n") + page;
  }, "");
}

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;
const ENDS_SENTENCE = /[.!?;:。！？；：)）\]】"”]$/;
const STARTS_BLOCK =
  /^(?:[0-9]+[.、)]|\(?[0-9a-zA-Z]\)|[ivxIVX]+\.|第[一二三四五六七八九十百0-9]+[章条节款]|[•·\-*])/;
/** A form field that starts its own line: "地址：", "联系人：", "Phone:". */
const LABEL = /^[^\s:：，。,.]{1,8}[：:]/;
/** A capitals-only line, such as a clause heading ("PAYMENT TERMS"). */
const HEADING = /^[A-Z][A-Z .&'-]{4,}$/;

/**
 * Rejoin lines that a PDF wrapped in the middle of a sentence, so that an amount or a clause
 * is one piece of text again ("…本协" + "议…", "between" + "(the Sublessor)"). Lines that end a
 * sentence, and lines that start a numbered clause or a heading, stay separate.
 */
export function unwrapLines(lines: string[]) {
  const out: string[] = [];
  // The line as the PDF printed it: only a line that ran to the margin can continue on the next.
  let printed = "";
  for (const raw of lines) {
    const line = raw.trimEnd();
    const previous = out[out.length - 1];
    const next = line.trimStart();
    const wrapped =
      previous &&
      next &&
      !ENDS_SENTENCE.test(previous) &&
      !STARTS_BLOCK.test(next) &&
      !LABEL.test(next) &&
      !HEADING.test(next) &&
      !HEADING.test(previous) &&
      printed.trim().length > 25;
    printed = line;
    if (wrapped) {
      const joiner = CJK.test(previous.slice(-1)) && CJK.test(next[0]!) ? "" : " ";
      out[out.length - 1] = previous + joiner + next;
    } else {
      out.push(line);
    }
  }
  return out;
}

// ---------------------------------------------------------------- Long contracts

/** Paragraphs that state money: an amount, a percentage or a payment term. Kept first. */
const MONEY =
  /[$€£¥￥]\s?\d|\d[\d,.]*\s?(?:%|％|usd|eur|gbp|rmb|cny|dollars?|euros?|pounds?|元|万元)|\b(?:fees?|price|payments?|payable|pay|paid|invoices?|deposit|retainer|instal(?:l)?ments?|compensation|balance|refund(?:s|ed)?)\b|付款|支付|费用|价款|价格|金额|报酬|定金|订金|押金|保证金|退款|退还|分期|首付|尾款/i;
/** Paragraphs about delivery, acceptance and ending the agreement. Kept while room remains. */
const TERMS =
  /milestone|accept|deliverabl|terminat|cancel|penalt|bonus|warrant|escrow|验收|交付|里程碑|阶段|违约|终止|解除/i;

/** Normalised paragraphs: collapses blank runs and spaces left by layout. */
export function tidy(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/[ \t\u00a0]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Text that fits one message. A long contract keeps its opening (parties, scope) and every
 * paragraph about money, delivery and acceptance, in order; other clauses are marked as left
 * out. The user sees the result before sending it.
 */
export function condense(text: string, limit = MAX_TEXT_CHARS) {
  if (text.length <= limit) return { text, condensed: false };
  const paragraphs = text.split(/\n(?:\s*\n)?/);
  const keep = new Set<number>();
  let used = 0;
  const take = (index: number) => {
    if (keep.has(index) || index < 0 || index >= paragraphs.length) return true;
    const size = paragraphs[index]!.length + 1;
    if (used + size > limit - 200) return false;
    keep.add(index);
    used += size;
    return true;
  };
  // A paragraph with its heading line ("4. Fee Payment Schedule"), when it has a short one.
  const takeWithHeading = (index: number) => {
    if (paragraphs[index - 1] && paragraphs[index - 1]!.trim().length < 80) take(index - 1);
    take(index);
  };
  // The opening names the parties and the work.
  for (let i = 0; i < paragraphs.length && used < limit * 0.15; i++) take(i);
  // Every paragraph that states money comes next, wherever it is; then delivery and acceptance
  // terms while there is room. Words like "deliver" also fill product descriptions, so they rank
  // below amounts and payment terms.
  paragraphs.forEach((paragraph, i) => MONEY.test(paragraph) && takeWithHeading(i));
  paragraphs.forEach((paragraph, i) => TERMS.test(paragraph) && takeWithHeading(i));
  const out: string[] = [];
  let skipped = false;
  paragraphs.forEach((paragraph, index) => {
    if (keep.has(index)) {
      if (skipped) out.push("[…]");
      out.push(paragraph);
      skipped = false;
    } else {
      skipped = true;
    }
  });
  if (skipped) out.push("[…]");
  return { text: out.join("\n"), condensed: true };
}

// ---------------------------------------------------------------- Entry point

export async function readContractFile(
  file: File,
  options: { loadPdf?: () => Promise<PdfLibrary>; limit?: number } = {},
): Promise<ContractText> {
  const kind = extension(file.name);
  if (file.size === 0) throw new ContractFileError("This file is empty.");
  if (file.size > MAX_FILE_BYTES)
    throw new ContractFileError("This file is larger than 15 MB. Upload the contract text only.");
  if (kind === "doc")
    throw new ContractFileError(
      "Older .doc files can't be read. Save it as .docx or PDF and upload it again.",
    );
  if (
    ["png", "jpg", "jpeg", "heic", "webp", "gif", "tif", "tiff"].includes(kind) ||
    file.type.startsWith("image/")
  )
    throw new ContractFileError(
      "Photos of a contract have no text to read. Upload a PDF or Word file, or paste the text.",
    );
  const bytes = new Uint8Array(await readBytes(file));
  let raw: string, pages: number | undefined, type: ContractKind;
  if (kind === "pdf" || file.type === "application/pdf") {
    ({ text: raw, pages } = await readPdf(bytes, options.loadPdf ?? loadPdfLibrary));
    type = "pdf";
  } else if (kind === "docx") {
    raw = await readDocx(bytes);
    type = "docx";
  } else if (["txt", "md", "text", ""].includes(kind) || file.type.startsWith("text/")) {
    raw = new TextDecoder().decode(bytes);
    type = "text";
  } else {
    throw new ContractFileError("Upload a PDF, Word (.docx) or text file.");
  }
  const text = tidy(raw);
  if (text.replace(/\s/g, "").length < 20)
    throw new ContractFileError(
      type === "pdf"
        ? "This PDF has no selectable text; it is probably a scan. Upload a Word or text version, or paste the text."
        : "This file has no readable text.",
    );
  const fitted = condense(text, options.limit ?? MAX_TEXT_CHARS);
  return {
    name: file.name,
    kind: type,
    text: fitted.text,
    fullLength: text.length,
    condensed: fitted.condensed,
    pages,
  };
}

/** The message that carries an uploaded contract into the conversation. */
export function contractMessage(contract: ContractText) {
  const pages = contract.pages ? `, ${contract.pages} page${contract.pages === 1 ? "" : "s"}` : "";
  const note = contract.condensed
    ? " Long clauses that do not mention money, delivery or acceptance were left out ([…])."
    : "";
  return `Contract file: ${contract.name}${pages}.${note}\n\n${contract.text}`;
}

/** The heading and text of a message created from an uploaded contract, or null. */
export function uploadedContract(message: string) {
  if (!message.startsWith("Contract file:")) return null;
  const end = message.indexOf("\n\n");
  if (end < 0) return null;
  return { heading: message.slice(0, end), text: message.slice(end + 2) };
}
