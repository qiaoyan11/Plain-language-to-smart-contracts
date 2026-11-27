export type DraftLanguage = "zh" | "en";

// Keep the conversation language when a later message contains only wallet addresses.
export function isChineseDraft(messages: Array<{ content: string }>) {
  return messages.some(({ content }) => /\p{Script=Han}/u.test(content));
}
