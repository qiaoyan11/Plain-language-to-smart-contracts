# Generation HTTP API v1

This is the connection for the new frontend: review rules → explicitly confirm → start Agent 2 → poll the result. It is implemented in `backend/generation.cjs` and routed by `backend/server.cjs`. The frontend now calls it from the agreement review and project pages.

Project API v2 and Python handoff v1 are unchanged. A generation run is a separate resource, not a field added to the Project object. The backend calls the existing Python worker; it does not implement another repair loop.

## Scope and enablement

- Local development only, with the two addresses from `GET /api/local-accounts`. No authentication, browser wallet or public hosting is added.
- Default `npm run backend` leaves generation disabled. Once Python, the validator and the local API key are configured as described in [Agent 2 setup](../agent2/README.md), explicitly start with `AGENT2_MODE=live npm run backend` to enable paid calls. The Node switch must be in the process environment, not only in `.env`.
- Server-owned configuration: development validation, feedback setting C, `maxRepairs=3`, model `gpt-5.4-mini-2026-03-17`. This means at most one initial generation plus three repairs, with early stop on success or tool error. This is the current development configuration, not a formal A/B/C experiment budget.
- Browser requests cannot set a model, budget, source bundle, validation report, signing key or confirmation timestamp.
- The normal local backend saves project rules, confirmations, runs, request keys and test-chain receipts in `data/private/local-demo/`. Restarting it with the same directory restores these records at the original project URL. A running generation interrupted by a restart is marked interrupted and requires an explicit new request. This state stays on this computer; moving to another computer or deleting the data directory does not preserve the URL's project. Python's detailed run artifacts are separately written under `artifacts/agent2/`.
- After a successful generation, a user can deploy the validated artifact to the local Hardhat chain (31337). The reference demo uses its own deployment action. The home-page conversation requires `AGENT1_MODE=live`; generation requires `AGENT2_MODE=live`; optional natural-language operation planning requires `AGENT3_MODE=live`. Direct deposit and milestone buttons make no model request.

## Resources

All paths below start with `/api/projects/:projectId`. Missing projects return 404. Existing project creation and reading use [Project API v2](PROJECT_API_V2.md).

| Method | Suffix | Request | Response |
| --- | --- | --- | --- |
| GET | `/agreement` | None | 200 AgreementContext |
| PUT | `/terms` | `{expectedSpecVersion, draft}` | 200 AgreementContext |
| POST | `/confirmation` | `{specVersion, approved: true}` | 200 AgreementContext |
| POST | `/generation-runs` | `{specVersion, confirmationId, idempotencyKey}` | 202 GenerationRun, or 200 for a replay |
| GET | `/generation-runs/:runId` | None | 200 GenerationRun |
| POST | `/generation-runs/:runId/deployment` | `{approved:true,specVersion,confirmationId}` | 201 Project, or 200 for the same deployment |

The write bodies require exactly the listed keys. `draft` has exactly `{name, clientWallet, developerWallet, milestones}`; use the existing ProjectDraft format. The backend assigns sequential milestone IDs and computes the exact total from positive integer wei strings. It never copies payment state into generation rules.

`expectedSpecVersion` and `specVersion` must be positive integers. A mismatched current version returns 409, so an old browser tab cannot silently overwrite new rules. An accepted terms update increments the version, clears confirmation and latestRunId, and marks previous runs obsolete. Deployed projects cannot be edited or start a new generation; create another project instead.

## Response shapes

`ConfirmedSpec`, `ConfirmationRecord` and `GenerateResult` below are the existing types in [handoff v1](INTERFACES.md), defined by [the shared JSON Schema](schemas/handoff.schema.json). Do not invent a second interpretation of those objects.

```typescript
type AgreementContext = {
  interfaceVersion: 1;
  spec: ConfirmedSpec;
  confirmation: ConfirmationRecord | null;
  latestRunId: string | null;
  generationEnabled: boolean;
  generatedDeploymentEnabled: boolean; // capability of this local backend
  recoveredOnFreshChain?: boolean; // startup import from a saved Agent 2 archive, with no prior transactions
  operationsEnabled: boolean;
  deployment: null | {kind: "generated" | "reference"; runId: string | null; contractAddress: string; chainId: number; sourceHash: string; specVersion: number};
};

type GenerationRun = {
  schemaVersion: 1;
  id: string;
  projectId: string;
  specVersion: number;
  confirmationId: string;
  status: 'running' | 'completed' | 'error' | 'obsolete';
  createdAt: string;
  finishedAt: string | null;
  result: GenerateResult | null;
  error: {
    code: 'GENERATION_TIMEOUT' | 'GENERATION_TOOL_ERROR' | 'GENERATION_INTERRUPTED';
    message: string;
  } | null;
  generatedDeploymentEnabled: boolean; // eligible to deploy now
  // Optional, only while status is 'running': the stage the worker last reported. Advisory;
  // removed when the run ends. Stages: writing, checking, repairing, finishing.
  progress?: { stage: 'writing' | 'checking' | 'repairing' | 'finishing'; attempt: number;
    maxAttempts: number; failedChecks: Array<'compilation' | 'staticAnalysis' | 'clauseTests'>; at: string };
};
```

Timestamps are ISO date-time strings. These HTTP responses are the resources themselves, not Python's `{interfaceVersion, requestId, status, result, errors}` envelope. Only Node constructs that worker envelope from its stored confirmed rules.

## Confirmation and starting a run

1. Create a project with `POST /api/projects`, complete the home-page draft and confirmation flow, or retrieve an existing project.
2. Fetch `/agreement` and display its rules. Creating a project is **not** an Agent 2 confirmation.
3. To save edits, PUT `/terms` with the displayed version and the entire new draft. Use the returned spec, rather than assuming IDs or totals.
4. Only when the user explicitly confirms this version, POST `/confirmation` with that specVersion and `approved: true`. The home-page draft uses its separate `/api/drafts/:id/confirmation` endpoint. Node creates the confirmationId and timestamp. Repeating confirmation of unchanged rules returns the same confirmation.
5. When the user chooses **Generate**, create a key such as `crypto.randomUUID()`. POST `/generation-runs` using the returned confirmationId and specVersion. Store the key before sending; reuse the same key if the network response is lost.
6. Store the returned run ID and GET `/generation-runs/:runId` about every two seconds while it is running. Refreshing the page should fetch `/agreement` and use latestRunId to resume polling, not POST another generation.

Example request bodies, with values taken from the previous response:

```json
{ "specVersion": 1, "approved": true }
```

```json
{
  "specVersion": 1,
  "confirmationId": "<confirmationId returned by Node>",
  "idempotencyKey": "<new UUID for this user-requested run>"
}
```

The key must contain 8–128 letters, digits, underscores or hyphens. Reusing it for the same project/version/confirmation returns the original run, including when that run failed or became obsolete. Reusing it for different rules returns 409. A deliberate new attempt uses a new key; no automatic paid retry occurs in Node. Python's bounded repairs belong to the same run.

Only one worker per project may run at a time. Editing rules invalidates its result but does not cancel the worker or release its lock early. An obsolete run may temporarily have `finishedAt: null`; starting another run returns 409 until cleanup finishes. A previously completed result is retained as obsolete history, never approval for the new rules.

## Displaying outcomes accurately

| Run status | Display and behavior |
| --- | --- |
| `running` | “Generating and checking your contract.” Continue polling; result is null. |
| `completed` + result.status `validated` | Show the report and enable explicit local deployment if this run is current, confirmed and eligible. |
| `completed` + result.status `failed` | Checks failed. Show the failed checks and stop; no automatic deployment or retry. |
| `completed` + result.status `toolError` | A model/tool step could not finish. Show a tool problem, not a successful contract. |
| `error` | Transport, timeout or invalid worker response. Show the safe error message and offer an explicit retry. |
| `obsolete` | Rules changed or the worker returned an outdated version. Do not use this result for the current agreement. |

HTTP 200 and run status `completed` do not mean validation passed. Inspect result.status and validationReport. The receiver rejects compilation-only `generated` results in this development flow, as well as malformed output and mismatched source/report identifiers.

The current response contains the **final** source and report plus attempts (attempt number, source hash, report ID and allowed feedback). It does not stream the current tool, a progress percentage, or every round's full report/source. Those detailed records are stored by Python on disk. A frontend can show the final checks and recorded attempt history; it must not animate invented live tool results or claim full per-round reports are available from this endpoint.

## Errors and integration limits

HTTP errors use the existing `{error: "message"}` body: 400 malformed input, 403 foreign host/origin, 404 missing project/run, 405 wrong method, 409 stale rules/busy/deployed project, 413 oversized body, 503 generation disabled. A worker failure after a run was accepted is reported in the polled run, not as a retroactive HTTP error.

Deployment resolves the latest stored validated run, checks its confirmation and version, and submits the trusted artifact's bytecode with the confirmed client, provider and milestone amounts. GET `/agreement` supplies its address and source identity. Repeating the same successful deployment returns the current project. Superseded runs and a second, different deployment return 409. Project snapshots keep the Project API v2 format. A startup-only import of a checked Agent 2 archive onto a fresh local chain is distinct from reopening the persisted chain: it has no prior deployment or payment receipts.

For Agent 3 the project page calls `/plans` and `/plans/:planId/confirmation`. The backend supplies the ABI and address recorded at deployment. Generated-project payments use these plan endpoints. See [operation planning and receipts](INTERFACES.md#7-agent-3--plan-an-operation-then-report-the-result).

Verification: `npm run test:api` covers the original reference lifecycle and these generation endpoints. Controlled worker outputs are fixtures, not claims that AI or independent validation ran. One test also crosses the actual Node→Python boundary in stub mode and checks that its refusal is surfaced. No API test calls a paid model.
