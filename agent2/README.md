# Agent 2 — Generation and repair

Owner: Member B. Branch: feature/agent2.

Input: confirmed specification, plus source and error report for repairs. Output: Solidity source, compiler version, dependencies, entry contract name and source hash.

Generate code, call verification and repair within a retry limit. Never claim success without tool results. Never edit independent evaluation tests. Help D deploy the exact verified artifact.

Status: not implemented. See ../shared/INTERFACES.md. Add setup instructions and examples with implementation.
