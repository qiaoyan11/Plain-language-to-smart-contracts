import { Fragment } from "react";
import type { DraftSession } from "@/api/types";

export function latestDraftQuestion(session: DraftSession | undefined) {
  const latest = session?.turns?.at(-1);
  return latest ? latest.question : (session?.result?.questions[0] ?? null);
}

export function DraftConversation({ session }: { session: DraftSession | undefined }) {
  return (
    <div aria-label="Agreement conversation" role="log" className="space-y-4">
      {session?.messages.map((message, index) => {
        const turn = session.turns?.[index];
        // Older sessions have no saved assistant turns. Show only their current result,
        // without inventing replies for earlier messages.
        const legacy = !turn && index === session.messages.length - 1 && session.result;
        const reply =
          turn?.reply ??
          (legacy
            ? "Your current payment summary is loaded. Check the rules alongside this conversation."
            : null);
        const question = turn ? turn.question : legacy ? session.result?.questions[0] : null;
        return (
          <Fragment key={turn?.revision ?? index}>
            <div className="chat-message chat-user">
              <p className="mb-2 text-xs font-medium text-muted-foreground">You</p>
              <p className="whitespace-pre-wrap break-words text-sm leading-7">{message.content}</p>
            </div>
            {reply && (
              <div className="chat-message" data-revision={turn?.revision}>
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  Agreement assistant
                </p>
                <p className="whitespace-pre-wrap break-words text-sm leading-7">{reply}</p>
                {question && (
                  <p className="mt-3 whitespace-pre-wrap break-words text-sm font-medium leading-7">
                    {question.question}
                  </p>
                )}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
