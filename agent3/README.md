# Agent 3 — Contract interaction

Owner: Member D, with B supporting deployment. Branch: feature/agent3.

Read current chain state, prepare allowed calls, obtain user wallet approval and verify receipts. Keep project IDs mapped to network, address and ABI.

Deploy only the artifact verified by C, using actual confirmed constructor arguments. Never handle mainnet private keys or sign for users. A transaction hash does not prove success.

Status: not implemented. See ../shared/INTERFACES.md.
