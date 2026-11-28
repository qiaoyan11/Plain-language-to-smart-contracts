/**
 * Confirming an agreement is the go-ahead for everything up to the deposit: the confirm page
 * marks the project, and the project page then sets up the checked contract without another
 * click. The mark lives in this tab only and names one confirmation, so older projects and
 * other confirmations are never set up automatically.
 */
const KEY = "accord:auto-deploy:";

export function markAutoDeploy(projectId: string, confirmationId: string) {
  try {
    sessionStorage.setItem(KEY + projectId, confirmationId);
  } catch {
    // Without storage the project page simply shows its set-up button.
  }
}

/** True once for the marked confirmation; the mark is removed. */
export function takeAutoDeploy(projectId: string, confirmationId: string) {
  try {
    if (sessionStorage.getItem(KEY + projectId) !== confirmationId) return false;
    sessionStorage.removeItem(KEY + projectId);
    return true;
  } catch {
    return false;
  }
}
