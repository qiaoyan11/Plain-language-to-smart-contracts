# Agreement frontend and local chain

The conversation-based frontend is in `frontend/`. Data calls remain centralized in `frontend/src/api/client.ts`. Platform-specific build plugins and reporting hooks have been removed.

## Run locally

The frontend requires modern Node (22.12+ recommended; frontend tests and build verified with Node 24.22.1). The backend reference demo was developed with Node 20.11. No API keys or browser wallet are needed for this local-only stage.

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

The backend runs a real local EVM inside its process, automatically signing with disposable test accounts. It is not connected to Ethereum mainnet or Sepolia. Only the designated client/provider demo accounts are accepted; arbitrary addresses from the earlier mock example will be rejected. Project records and the chain are in memory and reset together on backend restart.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/local-accounts` | Get usable local client and provider addresses |
| POST | `/api/projects` | Create a confirmed project with name, addresses and 1–5 milestones |
| GET | `/api/projects/:id` | Get project metadata and freshly read chain state |
| POST | `/api/projects/:id/actions` | Execute deploy, deposit, or acceptMilestone with a milestoneId |

Agent 2 now has a separate [generation HTTP API](../shared/GENERATION_API_V1.md) for rule revisions, explicit confirmation, asynchronous generation and polling. The agreement UI now calls it: describe or supplement text at `/`, edit payment fields, review and explicitly confirm at `/confirm`, then view generation at `/projects/:id`. Agent 1 is still a labelled script; arbitrary text requires manual payment-field editing. Supplemental text stays in the browser, outside the generated contract. Creating a project through the table above does not create that AI confirmation. The existing deploy action always uses the handwritten reference contract.

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
