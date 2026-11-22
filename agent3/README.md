# Agent 3: operation planner

## 1. Purpose

Agent 3 reads one sentence from a client. It returns an escrow operation intent.
The client can ask about the escrow, deposit funds, or accept a milestone.
The client must confirm the intent before anyone sends a transaction.
Agent 3 never signs or sends a transaction.

## 2. Owner and branch

- Owner: Xiangyi Zhu
- Branches: `feature/agent3` (module), `feature/agent3-integration` (backend and web page)

## 3. Input and output

The interface is in `shared/INTERFACES.md`, section 7. The input is a `PlanInput`
(project, deployment, snapshot, and the message). The output is a `PlanResult`.
The `status` field has one of three values:

| Status | Meaning |
| --- | --- |
| `readyForConfirmation` | The intent is safe. The client must confirm it. |
| `needsClarification` | Agent 3 asks one question. |
| `blocked` | Agent 3 refuses. The summary gives the reason. |

## 4. How it decides

The model only classifies the sentence. The rules in `agent3/rules.py` make every decision.
The model never writes the summary, the question, or the intent.

The model returns three fields:

| Field | Values |
| --- | --- |
| `kind` | `query`, `deposit`, `acceptMilestone`, `unsupported`, `unclear` |
| `milestoneId` | An integer (1 or more) or `null` |
| `language` | `zh` or `en` |

The function `decide` applies these rules in order. The first rule that matches wins.

| # | Condition | Result |
| --- | --- | --- |
| 1 | Snapshot address differs from deployed address | `blocked` |
| 2 | The milestone ids are not 1 to n in order | `blocked` |
| 3 | `kind` is `unsupported` | `blocked` |
| 4 | `kind` is `unclear` | `needsClarification` |
| 5 | `kind` is `query` | `readyForConfirmation`, action `query` |
| 6 | `deposit` and the model also gives a milestone number | `needsClarification` |
| 7 | `deposit` and the escrow is funded | `blocked` |
| 8 | `deposit` and the escrow is not funded | `readyForConfirmation`, action `deposit` |
| 9 | `acceptMilestone` and all milestones are paid | `blocked` |
| 10 | `acceptMilestone` and no milestone number | `needsClarification` (names the next unpaid milestone) |
| 11 | The milestone does not exist | `blocked` |
| 12 | The escrow is not funded | `blocked` |
| 13 | The milestone is already paid | `blocked` |
| 14 | A lower milestone is unpaid | `blocked` |
| 15 | All checks pass | `readyForConfirmation`, action `acceptMilestone` |

`agent3/service.py` handles these cases before and after the model call:

- An empty message gets a question.
- A message over 2000 characters is refused.
- Any model error is refused with a safe message.

The replies are in Chinese or English, as the client wrote.

### Report after a transaction

`agent3/report.py` tells the client the result of a confirmed deposit or milestone acceptance.
It does not call the model. It uses the transaction receipt and a snapshot that Node reads after the transaction.

Input: `{projectId, intent, receipt, snapshot, language}`. `receipt` is `{hash, blockNumber, status}` or `null`.
Output: `{outcome, summary}`.

| Outcome | Condition |
| --- | --- |
| `confirmed` | For this project and contract, the receipt matches a successful recorded transaction by hash, block, status, action and milestone. The snapshot shows funding and, for acceptance, the paid milestone. |
| `failed` | A status-0 receipt for this attempt reports a revert. Earlier deposits and payments keep their own outcomes. |
| `unverified` | The receipt is missing, the project or contract differs, or the successful receipt lacks the matching transaction record or state. |

The deposit report shows the current escrow balance, including any later payouts.

## 5. Run it

Prerequisites:

- Python virtual environment at `.venv`.
- For live mode: `OPENAI_API_KEY` in the environment or in `.env` at the repository root. Never commit `.env`.

Stub mode (default, no network):

1. Run `.venv/bin/python -m agent3 shared/examples/planAction.request.json`
2. Stub mode always returns `blocked`. The summary starts with "STUB:".

Live mode (one model call):

1. Run `AGENT3_MODE=live .venv/bin/python -m agent3 shared/examples/planAction.request.json`
2. The example project is not funded. The result is `blocked`: deposit first.

`AGENT3_MODEL` defaults to `gpt-5.6-luna`. This is the only allowed model.
Agent 3 reads `AGENT3_MODEL` from the environment only, not from `.env`.

### Use it from the web page

Prerequisites: the steps in `docs/FRONTEND_INTEGRATION.md` work, and `OPENAI_API_KEY` is set.

1. In the repository root, run `AGENT3_MODE=live npm run backend`
2. In `frontend/`, run `npm run dev`
3. Open `http://127.0.0.1:5173/reference-demo` and create a project.
4. On the project page, select "Deploy contract".
5. Type a request in "Ask in plain language" and select "Ask".
6. Read the proposed operation. Select "Confirm and send" to execute it.
7. Read the report. It comes from the transaction receipt.

HTTP endpoints (see `shared/INTERFACES.md` section 7):

- `POST /api/projects/:id/plans` with `{message}`
- `POST /api/projects/:id/plans/:planId/confirmation` with `{approved: true}`

## 6. Tests

Offline tests (no network):

1. Run `npm run test:agent3`

Evaluation with the real model (32 calls, costs money):

Prerequisite: `OPENAI_API_KEY` is set. `AGENT3_MODE` has no effect on the evaluation.

1. Run `.venv/bin/python -m agent3.evaluate`
2. Read the report in `artifacts/agent3/<timestamp>/report.json`.
3. The command exits with code 1 if the planning evaluation is incomplete, a critical error occurs, or a receipt report gives a false success.

The planning report records the number of model calls attempted (`modelAttempts`), cases
scored (`validCases`), and cases with a model error (`modelErrors`). A model error keeps
the planner's safe fallback in the report and leaves the case's `correct` field null.
An empty case set or any model error marks the run `incomplete` and leaves overall
`accuracy` null. The `correct` count still shows how many scored cases matched the expected plan.

The command also scores 20 receipt cases in `agent3/cases/receipts.json`. These cases use no model call.
A false success is a report that says `confirmed` when the expected outcome is `failed` or `unverified`.

A critical error is a sentence that must be refused or clarified, but came back as ready.
It is also a ready result with the wrong action or milestone. Critical errors are counted apart from accuracy.

Measured result (3 runs on 2026-11-10, model `gpt-5.6-luna`, 30 sentences: 15 Chinese, 15 English):

| Measure | Value |
| --- | --- |
| Correct | 29 of 30 (run 1), 29 of 30 (run 2), 30 of 30 (run 3) |
| Unsafe | 0 in each run |
| Critical payment errors | 0 in each run |
| Slowest call | 1.847 s (run 1), 4.785 s (run 2), 2.153 s (run 3) |
| Calls over 5 s | 0 in each run |
| Receipt reports | 20 of 20 correct, 0 false success |

The one wrong case in runs 1 and 2: "付款。" with the escrow funded. Expected `needsClarification`; got `blocked`.
This is a refusal where a question was expected. There is no payment risk.
Run 3 gave the expected result for this case. The model is not deterministic, so a new run can differ.
The receipt reports use no model, so their result does not change between runs.

A live test on 2026-11-10 found one unsafe reading that the 30 sentences did not cover.
With an unfunded escrow, "先付第一阶段" (pay the first stage) came back as a deposit with a milestone number in 3 of 8 calls.
Rule 6 now stops this: Agent 3 asks a question. The two sentences `zh-16` and `en-16` were added to the set.
Run 4 (32 sentences, with rule 6): 31 of 32 correct, 0 unsafe, 0 critical. The one wrong case is `zh-16`: expected `blocked`, got `needsClarification`.

## 7. Limits

- Each call is independent. There is no memory of earlier turns. The answer to a question must be a complete sentence, for example "accept milestone 1".
- The model call has a hard limit of 8 seconds. After that time, Agent 3 returns a refusal.
- The Node bridge stops Python after 10 seconds by default. This is when `AGENT2_MODE` is not `live`.
- Agent 3 is verified only against the handwritten reference contract on local Hardhat.
- The web page uses Agent 3 only if the backend starts with `AGENT3_MODE=live`. Without it, the plan endpoint returns 503.
- Node keeps one plan for each project for 10 minutes. A new request replaces the earlier plan.
- Sepolia and browser-wallet signing are not done.
- Agent 3 never signs or sends a transaction.
