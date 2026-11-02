# Lovable frontend and local chain

The exported Lovable frontend is in `frontend/`. Its layout and routes are preserved. Data calls remain centralized in `frontend/src/api/client.ts`.

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

Open http://127.0.0.1:5173. Click **Use local demo accounts**, enter a project name, review, create, deploy, deposit, then approve both milestones. Each completed action displays a receipt transaction hash and block number. Reloading reads the latest contract state from the backend.

The backend runs a real local EVM inside its process, automatically signing with disposable test accounts. It is not connected to Ethereum mainnet or Sepolia. Only the designated client/provider demo accounts are accepted; arbitrary addresses from the earlier mock example will be rejected. Project records and the chain are in memory and reset together on backend restart.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/local-accounts` | Get usable local client and provider addresses |
| POST | `/api/projects` | Create a confirmed project with name and addresses |
| GET | `/api/projects/:id` | Get project metadata and freshly read chain state |
| POST | `/api/projects/:id/actions` | Execute `{ "action": "deploy\|deposit\|stage1\|stage2" }` |

The action value is one of the four individual strings, not the pipe-separated display above. Successful actions return the updated Project and confirmed transaction records. Failures return an HTTP error and `{ "error": "..." }`. No fallback to mock success occurs if the backend fails.

Vite proxies `/api` to `127.0.0.1:3001`. No public tunnel is needed. Do not expose this auto-signing backend publicly: it deliberately has no user authentication and controls test accounts. In the public-testnet stage, replace action execution with transaction preparation and wallet signing.

For the original frontend-only behavior set `VITE_API_MODE=mock`. In local mode the failure-simulation toggle is hidden and the banner identifies the local chain. Never connect the hosted Lovable preview directly to this local auto-signing service.

## Verification

```bash
npm test
npm run test:api
cd frontend
npm test
npm run build
```

The contract suite covers access, order, amounts, duplicates and transfer rollback. The HTTP test checks full lifecycle, incorrect addresses, a foreign origin, invalid actions and repeated operations.

Verified in the browser: create → deploy → deposit 0.01 ETH → first payment (balance 0.007 ETH) → second payment (balance 0 ETH). Reload preserved both paid statuses and all four confirmed transaction records. Frontend tests: 4 passed; HTTP lifecycle test: 1 passed; production build passed.
