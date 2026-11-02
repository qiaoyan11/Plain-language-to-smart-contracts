# First milestone — fixed two-stage escrow

This implements the agreed example without AI or a browser wallet. It executes real Solidity on a disposable local EVM, not mocked balances. No connection to a public network is configured.

## Run

Use Node.js 20 or 22 and npm. From the repository root:

```bash
npm ci
npm run compile
npm test
npm run demo
```

The compiler is a pinned npm dependency; no separate Solidity compiler download is required. Each command starts a fresh local chain, so the address printed by the demo cannot be used from an external wallet afterward.

## Expected demo

| Action | State | Escrow balance | Provider received |
| --- | --- | --- | --- |
| Deploy | AwaitingDeposit | 0 | 0 |
| Client deposits | Funded | 0.01 | 0 |
| Client accepts homepage | FirstPaid | 0.007 | 0.003 |
| Client accepts website | Completed | 0 | 0.01 |

All amounts are test ETH. Provider receipt is measured as a balance difference. The client's balance also pays simulated gas, so it is not used as the payment amount assertion.

## Stable interface for the next step

- Constructor: `client` and `provider` addresses; they must be different and nonzero.
- `deposit()` payable: client deposits exactly 0.01 ETH, once.
- `approveFirst()`: client approves milestone 1 and transfers 0.003 ETH.
- `approveSecond()`: client approves milestone 2 after milestone 1, transferring 0.007 ETH.
- `state()`: 0 = AwaitingDeposit, 1 = Funded, 2 = FirstPaid, 3 = Completed.
- Read the contract balance from the chain. Events record deposits and milestone payments.
- `artifacts/TwoStageEscrow.json` contains the generated ABI and bytecode after compilation.

## What comes next

The Lovable frontend continues using its mock API for now. Next, add a persistent local node plus a backend adapter around this interface; then replace mock calls with that adapter. Public-testnet interaction must use wallet-authorized transactions rather than these auto-unlocked local accounts. Later, Agent 3 prepares the same calls and Agent 2 produces contracts checked against the same behavioral requirements.

The Solidity reference and tests are reusable; the disposable simulation runner is only a development harness. This version has fixed amounts, no refunds, deadlines, disputes, agents or static-analysis integration. Client approval represents human acceptance, not automated quality assessment. Funds remain locked if the client never approves or the provider always rejects payment. This is not ready for real funds or public production deployment.
