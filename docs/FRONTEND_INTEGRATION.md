# Agreement frontend and local chain

The conversation-based frontend is in `frontend/`. Data calls remain centralized in `frontend/src/api/client.ts`. Platform-specific build plugins and reporting hooks have been removed.

## Run locally

The frontend requires Node 22.12 or newer; use a 22.x version for both services (the root package supports Node 20–22). The frontend tests and build were also verified with Node 24.22.1. The handwritten reference flow needs no API key or browser wallet. Live Agent 1, 2 or 3 requests need their configured model credentials and may incur charges.

From the repository root, in terminal 1:

```bash
npm ci
npm run backend
```

In terminal 2:

```bash
cd frontend
npm ci
npm run dev
```

Open http://127.0.0.1:5173/reference-demo for the preserved handwritten-contract flow. Click **Use local demo accounts**, enter a project name and 1–5 milestone titles and ETH amounts, then review, create, deploy, deposit, and approve each milestone in order. Each completed action displays a receipt transaction hash and block number. Reloading reads the latest contract state from the backend.

The backend runs a real local EVM inside its process, automatically signing with disposable test accounts. It is not connected to Ethereum mainnet or Sepolia. Only the designated client/provider demo accounts are accepted; arbitrary addresses from the earlier mock example will be rejected. The normal local service saves drafts, projects, confirmations, generation runs, signed test-chain blocks and receipts under `data/private/local-demo/`. A normal restart with the same data directory restores the same project URL, address and transaction history. This is local to this computer; deleting or replacing that directory, or opening the URL on another computer, does not restore it.

For the conversation-to-generated-contract flow, configure [Agent 1](../agent1/README.md) and [Agent 2](../agent2/README.md), then run `AGENT1_MODE=live AGENT2_MODE=live npm run backend` in terminal 1. Add `AGENT3_MODE=live` only if you want its model-based plain-language operation input. Open the home page, complete and confirm the payment rules, generate, then click **Deploy generated contract locally** on a validated run. On the project page, use the direct deposit and milestone buttons to preview each transaction and explicitly confirm it; these buttons do not call a model. Refresh to check the recorded address, receipts and balance. The optional Agent 3 text input can also prepare a transaction for confirmation and may incur model costs.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/local-accounts` | Get usable local client and provider addresses |
| POST | `/api/projects` | Create a project with name, addresses and 1–5 milestones; confirmation is separate |
| GET | `/api/projects/:id` | Get project metadata and freshly read chain state |
| POST | `/api/projects/:id/actions` | Execute deploy, deposit, or acceptMilestone with a milestoneId |

Agent 2 has a separate [generation HTTP API](../shared/GENERATION_API_V1.md) for rule revisions, explicit confirmation, asynchronous generation and polling. With `AGENT1_MODE=live`, the agreement UI sends the conversation to Agent 1 at `/`; Node saves the messages, draft and unsupported terms. Review and explicitly confirm at `/confirm`, then view generation at `/projects/:id`. Terms identified as separate written obligations remain outside the generated contract. Creating a project through the table above does not create an Agent 2 confirmation. The existing `/actions` deploy operation uses the handwritten reference contract; generated deployment has its own endpoint.

See [Project API v2](../shared/PROJECT_API_V2.md) for request and response fields. Amounts are integer wei strings throughout the API and converted to decimal ETH text only for display. Successful actions return the updated Project and confirmed transactions. Errors never fall back to mock success.

Vite proxies `/api` to `127.0.0.1:3001`. No public tunnel is needed. Do not expose this auto-signing backend publicly: it deliberately has no user authentication and controls test accounts. Public-testnet signing is outside this step; follow the decisions in WORKLOG before changing it.

For the original frontend-only behavior set `VITE_API_MODE=mock`. In local mode the failure-simulation toggle is hidden and the banner identifies the local chain. Never connect a hosted prototype directly to this local auto-signing service.

## Verification

```bash
npm test
npm run test:api
cd frontend
npm test
npm run build
```

The contract suite covers access, order, amounts, duplicates and transfer rollback. The HTTP test checks full lifecycle, incorrect addresses, a foreign origin, invalid actions and repeated operations.

Verified in the browser: create a three-stage project totaling 0.012000000000000001 test ETH → deploy → deposit → three sequential payments → zero balance. Refresh preserves the completed status and five transaction records. Contract tests: 26 passed; HTTP tests: 5 passed (1/2/3/5-stage flows and invalid requests); frontend tests at that baseline: 7 passed. The new agreement UI has 17 passing tests; see the latest WORKLOG for current verification.
