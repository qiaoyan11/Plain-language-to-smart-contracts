# Agent 3: operation planner

## 1. Purpose

Agent 3 reads one sentence from a client. It returns an escrow operation intent.
The client can ask about the escrow, deposit funds, or accept a milestone.
The client must confirm the intent before anyone sends a transaction.
Agent 3 never signs or sends a transaction.

## 2. Owner and branch

- Owner: Xiangyi Zhu
- Branch: `feature/agent3`

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
| 6 | `deposit` and the escrow is funded | `blocked` |
| 7 | `deposit` and the escrow is not funded | `readyForConfirmation`, action `deposit` |
| 8 | `acceptMilestone` and all milestones are paid | `blocked` |
| 9 | `acceptMilestone` and no milestone number | `needsClarification` (names the next unpaid milestone) |
| 10 | The milestone does not exist | `blocked` |
| 11 | The escrow is not funded | `blocked` |
| 12 | The milestone is already paid | `blocked` |
| 13 | A lower milestone is unpaid | `blocked` |
| 14 | All checks pass | `readyForConfirmation`, action `acceptMilestone` |

`agent3/service.py` handles these cases before and after the model call:

- An empty message gets a question.
- A message over 2000 characters is refused.
- Any model error is refused with a safe message.

The replies are in Chinese or English, as the client wrote.

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

## 6. Tests

Offline tests (49 tests, no network):

1. Run `npm run test:agent3`

Evaluation with the real model (30 calls, costs money):

Prerequisite: `OPENAI_API_KEY` is set. `AGENT3_MODE` has no effect on the evaluation.

1. Run `.venv/bin/python -m agent3.evaluate`
2. Read the report in `artifacts/agent3/<timestamp>/report.json`.
3. The command exits with code 1 if there is a critical error.

A critical error is a sentence that must be refused or clarified, but came back as ready.
It is also a ready result with the wrong action or milestone. Critical errors are counted apart from accuracy.

Measured result (run of 2026-11-10, model `gpt-5.6-luna`, 30 sentences: 15 Chinese, 15 English):

| Measure | Value |
| --- | --- |
| Correct | 29 of 30 (96.7%) |
| Unsafe | 0 |
| Critical payment errors | 0 |
| Slowest call | 1.847 s |
| Calls over 5 s | 0 |

The one wrong case: "付款。" with the escrow funded. Expected `needsClarification`; got `blocked`.
This is a refusal where a question was expected. There is no payment risk.
This is one run only. The model is not deterministic, so a new run can differ.

## 7. Limits

- Each call is independent. There is no memory of earlier turns. The answer to a question must be a complete sentence, for example "accept milestone 1".
- The model call has a hard limit of 8 seconds. After that time, Agent 3 returns a refusal.
- The Node bridge stops Python after 10 seconds by default. This is when `AGENT2_MODE` is not `live`.
- In live mode, `flows/worker.py` still prints a "STUB MODE" line to stderr.
- The result is correct. `flows/` has a different owner.
- Agent 3 is verified only against the handwritten reference contract on local Hardhat.
- The web page is not connected yet. Jiahao: set `AGENT3_MODE=live` for the planAction call.
- Agent 3 never signs or sends a transaction.
