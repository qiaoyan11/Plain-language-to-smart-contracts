# Shared module interfaces — draft v0.1

These are proposed contracts, not implemented endpoints. Agree on them before implementation. Every response carries project_id, spec_version, status and an errors list. No private keys.

## A: clarify
Input: user message, history and current specification. Output: questions, draft_spec and optional cited references. Status: needs_clarification or ready_for_confirmation. Only an explicit user action can create a backend confirmation record.

## B: generate and repair
Input: confirmed specification; repairs also receive prior code and verification findings. Output: source, entry contract, dependencies, compiler version, source hash and specification version. New code is unverified.

## C: validate
Input: confirmed specification and source bundle. Output: compilation, static-analysis and clause-test results with logs, source hash and spec_version. Status: passed, failed or tool_error. Skipped checks are not passes. Define severity thresholds before implementing.

On success return ABI, bytecode, constructor schema, build settings and artifact hash. Final held-out evaluation tests cannot be edited by B or used repeatedly for development tuning.

## D: deploy and operate
Deployment input: approved artifact, confirmation record, chain and actual constructor values. Verify hashes and versions match. Output: unsigned transaction and summary for wallet approval.

Operation input: user request, deployment record and wallet address. Read chain state, check the intended call and prepare a transaction.

Receipt input: chain ID and transaction hash. Output: pending, succeeded or failed, receipt and refreshed chain state. Do not infer success from a hash alone.

## Backend workflow
draft → awaiting_confirmation → generating → validating → ready_to_deploy → deployment_pending → active

Failed checks trigger bounded repair, then blocked if unresolved. Wallet rejection permits retry. Changes to rules invalidate confirmation and validation. Deployed contracts cannot silently change with a webpage edit.

Keep workflow state separate from on-chain business state. Money uses integer wei strings, never floating point. Validate addresses, positive amounts, unique milestone IDs and totals. See examples/agreement.draft.json.
