# Frontend collaboration

- Follow the repository AGENTS.md and shared HTTP contracts.
- Keep page data access in src/api/client.ts. Never fall back to simulated success after an HTTP error.
- Preserve the reference-demo routes and distinguish them from AI-generated contracts.
- Clarification uses the server-owned draft endpoints. Send only a message, expected revision and request key. Restore drafts with GET and persist only the active draft ID for the new flow.
- Preserve pending requests on errors and retry their original content and key only on an explicit user action. Show server questions, unsupported terms and separate written terms.
- Confirm the reviewed server revision explicitly. Confirmed conversation drafts are sealed. New terms require a new agreement.
- Keep deployment of validated generated code on the local chain, behind an explicit user click and the server's current run/confirmation eligibility. Use its generated deployment endpoint and keep handwritten reference actions in the reference demo.
- Describe only the payment rules the contract enforces.
