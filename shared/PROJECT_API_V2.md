# Project API v2

The HTTP/UI representation of a project is version 2. The Solidity interface remains `IMilestoneEscrow v1`. This is a breaking replacement of the fixed two-stage local-demo API; create new projects after restarting the backend. The fixed `TwoStageEscrow` and its tests remain unchanged as the baseline.

## Create project

`POST /api/projects`

```json
{
  "name": "Company website",
  "clientWallet": "<local client address>",
  "developerWallet": "<local provider address>",
  "milestones": [
    { "title": "Homepage", "amountWei": "3000000000000000" },
    { "title": "Full website", "amountWei": "7000000000000000" }
  ]
}
```

Use `GET /api/local-accounts` for the two supported local addresses. `name` and milestone titles must be nonblank and at most 120 characters. Provide 1–5 milestones in payment order. Amounts are canonical positive decimal integer strings (no signs, exponent notation, leading zeros or decimal points); their sum must fit uint256. The backend computes the total and assigns IDs starting at 1, ignoring caller-provided totals, IDs and paid flags. The frontend accepts ordinary ETH decimal text with up to 18 decimal places and converts it with BigInt, without rounding.

## Project response

Returns `schemaVersion: 2`, `id`, `name`, addresses, `createdAt`, `contractAddress` (null before deployment), `totalAmountWei`, `escrowBalanceWei`, `funded`, `milestones`, and `transactions`.

Each milestone contains `id`, `title`, `amountWei`, `paid`. Transactions contain `action`, optional `milestoneId`, `hash`, `blockNumber`, `status`. All amounts are strings; milestone IDs and block numbers are numbers. Old fields `totalEth`, `escrowBalance`, `deposited`, `paid.stage1/stage2`, and `chainState` are removed.

`GET /api/projects/:id` reads all deployed amounts, paid flags, funding status and balance at one common block. Titles and project metadata stay off-chain. Successful actions return the same Project representation after receipt confirmation. No database persistence is introduced; restarting the backend clears its projects and local chain.

## Actions

`POST /api/projects/:id/actions` accepts exactly one of:

```json
{ "action": "deploy" }
{ "action": "deposit" }
{ "action": "acceptMilestone", "milestoneId": 1 }
```

Deploy passes the confirmed amount array to `MilestoneEscrow`. Deposit sends the computed total. Acceptance invokes `acceptMilestone(id)`; funding, authorization, ordering and duplication are ultimately enforced by the contract. IDs must be integer numbers in range. `stage1` and `stage2` actions are no longer supported. A shared local signer permits only one transaction at a time; another operation receives 409 and may be retried after completion.

HTTP errors contain `{ "error": "..." }`: 400 for invalid input, 403 for foreign host/origin, 404 for missing project, 409 for busy or contract-rejected actions. No error falls back to a simulated success. This is a local-only auto-signing demo, not a public production API.
