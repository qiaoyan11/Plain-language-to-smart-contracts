# Agreement interface

React 19, TypeScript, TanStack Start, Vite and Tailwind 4. Standard framework plugins provide development and production builds; no hosted-editor plugin, project identifier, error-reporting hook or commit attribution rule is required.

## Run

Use Node 24 (tested with 24.22.1), or a compatible version >=22.12. From this directory:

```sh
npm ci
npm run dev
npm test
npx tsc --noEmit
npm run build
```

Start the Node backend separately from the repository root with `npm run backend`. Open http://127.0.0.1:5173. Vite proxies `/api` to the local backend at port 3001. Build output uses Nitro's Node server preset; building does not publish the app or turn it into a public service.

After installing both sets of dependencies, you can start both local services with `npm run demo:web` in the repository root. Use Node 22.12 or newer in the 22.x line for both. If the frontend uses a separate Node installation, set `DEMO_FRONTEND_NODE` to its executable. Set the agent modes described below for live model calls. The launcher reconnects a dropped service and stops both services on Ctrl+C.

## Two distinct flows

- `/`: describe an agreement and answer the drafting assistant. The server keeps the conversation and current payment summary. Use **Use local test accounts** to explicitly send the two local addresses. Once the remaining questions and unsupported payment terms are resolved, choose **Review agreement**.
- `/projects`: every project and unfinished conversation saved by the local backend, so a lost URL is not a lost project. Each project page also has **Copy project link**.
- `/confirm`: review the server-owned payment summary, original text and separate written terms. Acknowledge the payment scope and explicitly confirm the displayed revision. This creates the project and takes you to its generation page.
- `/projects/:id`: server-owned rule version and confirmation, generation request, polling, final checks, attempt references and source. Conversation-backed agreements are sealed after confirmation. Use **Start a new agreement** to change their terms. Earlier manually created projects retain their versioned editing flow. After the latest confirmed run passes the backend's checks, choose **Deploy generated contract locally**. Deployment is a separate click and uses the local test chain.
- `/reference-demo`, `/reference-review`, `/reference-projects/:id`: the preserved handwritten-contract demonstration: create, deploy locally, deposit and pay in order. These are not AI-generated contracts.

## Current limits

Agent 1 is connected when the backend starts with `AGENT1_MODE=live`. The server stores the original messages, full assistant history, pending requests, unresolved questions and separate written terms. The browser stores the active draft ID and restores it with GET after refresh. A failed message keeps its content, request key and revision on the backend. **Retry this message** reuses them after an explicit click. Pending or failed messages block confirmation of an earlier ready draft. The assistant can incur model costs.

The current contract supports a full upfront deposit and client-approved milestone payments. Refunds, deadlines, automatic acceptance and dispute settlement remain unsupported. Such payment requirements stay visible and block review until the user resolves them. Separate written terms are shown for human review. Agent 2 receives the confirmed payment fields.

Agent 2 generation is real when the backend is explicitly launched with `AGENT2_MODE=live`. Plain `npm run backend` leaves it disabled. The browser cannot choose models, budgets, source bundles or validation reports. Each explicit generation can incur model costs; polling and refresh never start a call. Request keys survive a lost response, including retries after a previous completed run.

The generation view shows actual returned outcomes. `completed` does not mean `validated`; tool failures and outdated results remain distinct. There is no fabricated progress percentage or streaming tool status. Full earlier-round reports remain backend artifacts, not browser results.

After local deployment, the project page displays the contract address, balance, funding state, milestones and transaction history returned by the backend. With `AGENT3_MODE=live` in the backend environment, **Ask in plain language** can query the escrow or propose a deposit or milestone payment. Asking can incur model costs. A proposed write has its own **Confirm and send** button. Refreshing the page restores the deployment and payment state from the backend. All three assistants can be enabled with `AGENT1_MODE=live AGENT2_MODE=live AGENT3_MODE=live npm run backend` from the repository root after their model settings are configured.

The reference demo also supports `VITE_API_MODE=mock`. In local API mode, reopening the same URL after a service restart reads the saved project and local-chain receipts. If a connection drops during deployment, wait for reconnection or choose **Refresh status** to check the recorded outcome. Interrupted model jobs require an explicit retry. Pending payment previews may need to be prepared and confirmed again.

## Code map

- `src/api/client.ts`: existing project API, versioned generation HTTP calls, exact wei arithmetic and reference-demo mocks.
- `src/api/types.ts`: TypeScript representations of shared wire types.
- `src/hooks/use-active-draft.ts`: restores the active server draft and polls only while a reply is pending.
- `src/components/DraftSummary.tsx`: current payment fields, unresolved questions, unsupported terms and original conversation.
- `src/api/workspace.ts`: retained browser context for earlier manually created projects.
- `src/components/AgreementEditor.tsx`: editable 1–5 milestone fields; optional wallet fields.
- `src/components/GenerationResultView.tsx`: final validation/source/attempt presentation.
- `src/components/OperationAssistant.tsx`: plan, confirm and display a receipt-based report for a deployed local escrow.
- `src/components/EscrowLedger.tsx`: per-milestone amount, recipient, paid state and receipt; transaction history; local-demo limits; project-link copying. Shared by the generated and reference project pages.
- `src/routes/projects.index.tsx`: saved projects and unfinished conversations.
- `src/routes/`: new agreement flow and separate reference flow.

Contract definitions: [Project API v2](../shared/PROJECT_API_V2.md), [Generation HTTP v1](../shared/GENERATION_API_V1.md), [Agent handoff v1](../shared/INTERFACES.md).

Tests cover exact amounts and reference payment guards, server draft restoration, pending-request retries, duplicate clicks, disabled confirmation for unresolved terms, confirmation recovery after a lost response, exact HTTP payloads, stale results and failed validation. They make no paid model calls. Open-source dependency license notices are retained.
