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

## Two distinct flows

- `/`: describe an agreement, keep adding details, expand the editable payment draft, then review it at `/confirm`. Wallets are collected during review. An explicit scope acknowledgement and confirmation are required.
- `/projects/:id`: server-owned rule version and confirmation, generation request, polling, final checks, attempt references and source. Editing rules or adding a note creates a new revision and requires confirmation again. After the latest confirmed run passes the backend's checks, choose **Deploy generated contract locally**. Deployment is a separate click and uses the local test chain.
- `/reference-demo`, `/reference-review`, `/reference-projects/:id`: the preserved handwritten-contract demonstration: create, deploy locally, deposit and pay in order. These are not AI-generated contracts.

## Current limits

Agent 1 is not connected. The example is an explicit script; arbitrary messages are preserved without pretending to extract their meaning. Users currently edit the payment fields themselves. Original conversation and additional terms stay in session storage in the current browser tab, separate from payment API payloads. They are not sent to Agent 2, evaluated by the validator or enforced on-chain. Acknowledging this limited scope is required before confirmation. The client still judges work quality; refunds, deadlines and automatic acceptance are unsupported.

Agent 2 generation is real when the backend is explicitly launched with `AGENT2_MODE=live`. Plain `npm run backend` leaves it disabled. The browser cannot choose models, budgets, source bundles or validation reports. Each explicit generation can incur model costs; polling and refresh never start a call. Request keys survive a lost response, including retries after a previous completed run.

The generation view shows actual returned outcomes. `completed` does not mean `validated`; tool failures and outdated results remain distinct. There is no fabricated progress percentage or streaming tool status. Full earlier-round reports remain backend artifacts, not browser results.

After local deployment, the project page displays the contract address, balance, funding state, milestones and transaction history returned by the backend. With `AGENT3_MODE=live` in the backend environment, **Ask in plain language** can query the escrow or propose a deposit or milestone payment. Asking can incur model costs. A proposed write has its own **Confirm and send** button. Refreshing the page restores the deployment and payment state from the backend. Both paid steps can be enabled together with `AGENT2_MODE=live AGENT3_MODE=live npm run backend` from the repository root after both agents are configured.

The reference demo can separately use `VITE_API_MODE=mock`; the AI flow does not fall back to those simulations after an HTTP error. Restarting the backend resets server projects, confirmations, runs and the local chain. Browser notes are not a backup of those records.

## Code map

- `src/api/client.ts`: existing project API, versioned generation HTTP calls, exact wei arithmetic and reference-demo mocks.
- `src/api/types.ts`: TypeScript representations of shared wire types.
- `src/api/workspace.ts`: browser-only conversation and supplemental notes; scripted sample.
- `src/components/AgreementEditor.tsx`: editable 1–5 milestone fields; optional wallet fields.
- `src/components/GenerationResultView.tsx`: final validation/source/attempt presentation.
- `src/components/OperationAssistant.tsx`: plan, confirm and display a receipt-based report for a deployed local escrow.
- `src/routes/`: new agreement flow and separate reference flow.

Contract definitions: [Project API v2](../shared/PROJECT_API_V2.md), [Generation HTTP v1](../shared/GENERATION_API_V1.md), [Agent handoff v1](../shared/INTERFACES.md).

Tests cover exact amounts and reference payment guards, message persistence, acknowledgement invalidation, HTTP payloads, idempotent network retries, stale results and failed validation. They make no paid model calls. Open-source dependency license notices are retained.
