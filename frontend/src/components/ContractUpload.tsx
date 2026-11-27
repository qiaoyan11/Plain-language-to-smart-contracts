import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ACCEPTED,
  ContractFileError,
  MAX_TEXT_CHARS,
  contractMessage,
  readContractFile,
  type ContractText,
} from "@/lib/contractFile";

/**
 * Upload an existing contract (PDF, Word or text). Its text is read in the browser and placed in
 * the message box, so the user can check it and add a line before sending. The file itself is
 * not uploaded anywhere.
 */
export function ContractUpload({
  disabled,
  current,
  onText,
  children,
}: {
  disabled: boolean;
  /** What is in the message box now: a note the user typed is kept below the contract. */
  current: string;
  onText: (text: string) => void;
  /** The message box: a contract can also be dropped onto it. */
  children: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "reading"; name: string }
    | { kind: "read"; contract: ContractText }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  // Once the message is sent (or cleared) the note about the last file no longer applies.
  useEffect(() => {
    if (!current) setState((previous) => (previous.kind === "read" ? { kind: "idle" } : previous));
  }, [current]);

  async function read(file: File | undefined) {
    if (!file || disabled) return;
    setState({ kind: "reading", name: file.name });
    try {
      // A new file replaces an earlier upload; anything else the user typed stays below it.
      const note = current.startsWith("Contract file:") ? "" : current.trim();
      const contract = await readContractFile(file, {
        limit: Math.max(4000, MAX_TEXT_CHARS - note.length),
      });
      onText(note ? `${contractMessage(contract)}\n\n${note}` : contractMessage(contract));
      setState({ kind: "read", contract });
    } catch (error) {
      setState({
        kind: "error",
        message:
          error instanceof ContractFileError
            ? error.message
            : "This file could not be read. Upload a PDF, Word (.docx) or text file, or paste the contract text.",
      });
    } finally {
      if (input.current) input.current.value = "";
    }
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void read(event.dataTransfer.files[0]);
  }

  return (
    <div>
      <div
        onDragOver={(event) => {
          if (disabled || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
        className={
          dragging ? "rounded-md outline outline-2 outline-offset-2 outline-primary" : undefined
        }
      >
        {children}
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void read(event.target.files?.[0])}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        disabled={disabled || state.kind === "reading"}
        onClick={() => input.current?.click()}
      >
        <Upload aria-hidden="true" />
        {state.kind === "reading"
          ? `Reading ${state.name}…`
          : "Upload a contract (PDF, Word or text)"}
      </Button>
      <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
        {state.kind === "read"
          ? `Read ${state.contract.name}${state.contract.pages ? `: ${state.contract.pages} page${state.contract.pages === 1 ? "" : "s"}` : ""}. ${
              state.contract.condensed
                ? `It is long, so the message keeps the opening and every clause about money, delivery and acceptance (${state.contract.text.length.toLocaleString("en-US")} of ${state.contract.fullLength.toLocaleString("en-US")} characters). `
                : ""
            }Check the text below, add anything else you agreed, then send it.`
          : "Or drop a file on the message box. The file stays on this computer; only its text is sent."}
      </p>
      {state.kind === "error" && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {state.message}
        </p>
      )}
    </div>
  );
}
