# Module handoff v1 — Python and LangGraph

This is the agreed contract for the next implementation, not an implemented API. Python agents and LangGraph have not been installed or connected yet. The working Node backend, frontend and Solidity contracts remain unchanged.

The existing [Project API v2](PROJECT_API_V2.md) continues to serve the current UI. `IMilestoneEscrow v1` in [WORKLOG](../docs/WORKLOG.md) is unchanged. This document replaces the earlier draft v0.1 and its snake_case example fields; no existing HTTP endpoint is renamed.

## 1. Architecture and ownership

```text
Existing UI -> existing Node backend -> one JSON bridge -> Python workflow
                                                        Agent 1 (later)
                                                        Agent 2 -> development validation -> repair
                                                        Agent 3 (later, proposes operations)
Existing Node backend -> existing contract tools -> local chain
```

Node owns project records, user confirmations, deployment records and transaction execution. Python owns AI work within a run; it does not maintain a second authoritative project database or hold signing keys. Agent 2 returns code and a report, not a deployed contract. Reference-contract deployment continues to work independently.

Use LangGraph first for the generation/check/repair loop. No Langflow service is required. Agent modules expose Python callables taking/returning JSON-compatible objects; they must be testable without starting the UI. LangChain is optional, not a required second orchestration layer. Dependency versions will be pinned when implementation starts.

## 2. One bridge, before adding services

Initial transport: Node launches a configured Python interpreter with a fixed module entry point (planned `flows.worker`), sends one JSON request on stdin, and receives one JSON response on stdout. Diagnostics go to stderr. No model-produced shell commands. The entry point is a future deliverable, not a command available today.

Envelope:

- Request: `{interfaceVersion: 1, requestId, operation, payload}`.
- Response: `{interfaceVersion: 1, requestId, status, result, errors}`.
- `operation`: `clarify`, `generate`, or `planAction`.
- `status`: `ok` or `error`. `ok` means the operation returned normally, not that code passed validation.
- `errors`: array of `{code, message, field}`; `field` is a string or null. `result` is null on errors.
- Missing required fields, unknown operations or an incompatible interface version return `error`; no automatic execution fallback.

The bridge must enforce timeout, output-size limits and one active run per project. A process crash, invalid JSON or timeout is a tool error, never a success. Node supplies requestId; late results for an obsolete specVersion are discarded. Retry is explicit and never submits a financial action. Transport limits are implementation settings to document and test, not experimental repair rounds.

## 3. ConfirmedSpec — shared business rules

JSON keys use camelCase in both languages. Python can use internal snake_case names, but serializes the documented keys.

| Field | Meaning |
| --- | --- |
| schemaVersion | Integer 1 for this specification; distinct from Project response schemaVersion 2 |
| projectId, specVersion | Node project ID and positive integer revision |
| name | Project name, 1–120 characters |
| clientWallet, developerWallet | Nonzero, distinct Ethereum addresses |
| milestones | Ordered array of 1–5 `{id, title, amountWei}` records |
| totalAmountWei | Sum of milestone amounts, recomputed and checked by trusted code |
| approvalRole | Literal `client` |
| refundPolicy | Literal `none` in this scope |
| deadline | null; timed rules are unsupported in this scope |

IDs are consecutive integers starting at 1. Titles are nonblank, at most 120 characters. Monetary values are positive integer wei strings, never floating-point numbers. Each value and the total must fit uint256. Original natural-language text is context, not executable instructions.

`DraftSpec` has the same keys but allows missing addresses, total, or milestone values to be null, and an empty milestones array while clarifying. It cannot be sent to generation. Unsupported refund/deadline requests must be disclosed, not silently converted to `none`/null and presented as equivalent.

Node converts a confirmed UI project into ConfirmedSpec: add projectId/specVersion and fixed supported policy values; remove deployed state, transaction history and milestone `paid` flags. The existing API does not yet implement this adapter or confirmation versions.

`ConfirmationRecord`: `{projectId, specVersion, confirmationId, confirmedAt}`. Only Node creates this after an explicit user action and retains the corresponding immutable spec. An agent-supplied record alone is not evidence of approval. Changing any rule increments specVersion and invalidates earlier confirmation/validation.

## 4. Agent 1 — clarify

Python callable: `clarify(payload) -> result`.

Input: `{message, history, draftSpec}`. History entries contain `{role, content}`; draftSpec may be null. Output: `{status, draftSpec, questions, unsupportedTerms}`.

- Status: `needsClarification`, `readyForConfirmation`, or `unsupported`.
- Questions: `{field, question}` entries; unsupportedTerms: strings explaining unhandled requirements.
- `readyForConfirmation` requires complete, valid supported terms; it is not user confirmation.
- Node presents the editable draft to the user; Agent 1 cannot confirm or deploy it.

First deliverable: one complete description, one missing-amount description and one unsupported refund request, with expected JSON outputs. RAG is not part of this first task.

## 5. Agent 2 — generate and repair

Python callable: `generate(payload) -> result`; the LangGraph workflow calls generation and repair nodes plus the independent development validator.

Input: `{spec, confirmation, runConfig}`.

`runConfig`: `{validationMode, maxRepairs, feedbackSetting, model}`. validationMode is `none` for a first single-generation smoke test or `development` for the integrated loop. maxRepairs is a nonnegative integer (0 means no repair); feedbackSetting is `baseline`, `A`, `B`, or `C`; model identifies the configured model, not an API key. Formal A/B/C definitions and the shared repair budget must come from the proposal and be recorded by the evaluation owner before experiments. No default may silently invent their meanings.

Result: `{status, sourceBundle, validationReport, attempts}`. Status: `generated`, `validated`, `failed`, or `toolError`. `generated` has no deployment permission. In mode `none`, validationReport is null. Each attempt records `{attempt, sourceHash, reportId, feedbackUsed}`; attempt 0 is initial generation. Only development feedback permitted by the selected experimental setting may be recorded in feedbackUsed or passed to repair.

`SourceBundle`:

- `projectId`, `specVersion`, `sources`: map of safe relative Solidity filenames to exact UTF-8 source strings.
- `entryFile`, `entryContract`, `compilerVersion` (initially `0.8.28`).
- `buildSettings`: `{evmVersion: "paris", optimizer: {enabled: true, runs: 200}}`.
- `dependencies`: [] initially; use the frozen interface and self-contained source rather than arbitrary downloads.
- `sourceHash`: SHA-256 over a canonical JSON object containing sources, entryFile, entryContract, compilerVersion, buildSettings and dependencies. Prefix with `sha256:`; lowercase hex. Canonicalize recursively by sorted keys, compact separators, UTF-8, unescaped Unicode, no trailing newline; source text itself is preserved. The validator recomputes the hash rather than trusting the model.

Generated contracts implement the frozen interface and constructor `(address client, address payable provider, uint256[] amounts)`. Generated files are per-run outputs, never replacements for contracts/MilestoneEscrow.sol or independent tests. Repair receives the immutable spec, previous source bundle and allowed development feedback. It may change code, not agreed rules or tests.

Graph: check input -> generate -> validate -> finish if passed; otherwise repair -> validate up to maxRepairs. On toolError stop and report the tool problem; do not treat it as a Solidity defect. Record every attempt. Passing is determined by the validator, not by the LLM.

## 6. Independent validation — owned by C and Claude

Requested Python boundary: `validate_development(spec, sourceBundle) -> ValidationReport`. This is an integration contract for the validation owner to implement or adapt; this change does not edit validation/.

`ValidationReport` fields:

- `reportId`, `projectId`, `specVersion`, `sourceHash`, `suiteVersion`, `mode` (`development`).
- `status`: `passed`, `failed`, or `toolError`.
- `checks`: `{name, status, findings}` records for compilation, staticAnalysis and clauseTests. Check status: passed/failed/skipped/toolError. Findings: `{code, severity, message, file, line}`; file/line may be null.
- `artifact`: null unless passed; otherwise `{abi, bytecode, compilerVersion, buildSettings, sourceHash, constructorTypes}`. constructorTypes is `["address", "address", "uint256[]"]`.

A report passes only when all required checks run and pass. Missing tools or skipped checks cannot produce a pass. The validation owner must document a versioned static-analysis blocking policy in suiteVersion before reporting passed; severity labels alone are not a policy. A/B/C controls which findings reach the repair model, not whether the full internal report is retained for evaluation.

Held-out evaluation is a separate, evaluator-only entry point, not a `mode` exposed to the generation graph. Its tests and findings never enter Agent 2 prompts or development fixtures. Build tools run in a restricted environment; Python calls fixed Node/compiler or Slither adapters, not arbitrary model-specified commands.

## 7. Agent 3 — plan an operation, later

Input: `{message, projectId, deployment, snapshot}`. Deployment is trusted Node data `{chainId, contractAddress, abi, sourceHash, specVersion}`. Snapshot is the existing Project API v2 response read from the chain.

Output: `{status, question, intent, summary}`. Status: `needsClarification`, `readyForConfirmation`, or `blocked`. Intent is null unless ready; then `{projectId, chainId, contractAddress, action, milestoneId}`. Allowed action values: `query`, `deposit`, `acceptMilestone`; milestoneId is null except for milestone acceptance. Query only returns read information. The model cannot choose arbitrary functions or addresses.

Before a state-changing action, Node checks the trusted deployment and latest state again and requires an explicit UI confirmation. It uses existing local demo execution tools; Python never signs transactions. Browser-wallet integration and public-testnet signing are separate future work. Deployment of generated code is also a later Node integration task: require a trusted passed report, match exact source/version/build settings, deploy the verified artifact with confirmed arguments, and verify the receipt. Existing reference deployment is not evidence that this generated-artifact gate exists today.

## 8. Shared fixtures and acceptance

See [draft](examples/agreement.draft.json), [generation request](examples/generate.request.json) and [tool-error response](examples/generate.tool-error.response.json). They are synthetic handoff fixtures, not actual model or validation results. The tool-error example intentionally cannot be deployed.

Each owner adds a module-local runner and tests when implementing. Initial integration milestone: Node sends one confirmed fixture to Python, receives a well-formed generated bundle or a clear tool error, and leaves the existing reference demo intact. Then connect development validation and bounded repair. Do not add a second HTTP backend, wallet service or database for this milestone.
