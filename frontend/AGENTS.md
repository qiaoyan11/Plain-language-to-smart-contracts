# Frontend collaboration

- Follow the repository AGENTS.md and shared HTTP contracts.
- Keep page data access in src/api/client.ts. Never fall back to simulated success after an HTTP error.
- Preserve the reference-demo routes and distinguish them from AI-generated contracts.
- Clarification is not connected to a real Agent 1 yet; label scripted guidance honestly.
- Conversation text and supplementary terms stay in browser storage, separate from payment API payloads.
- Keep deployment of validated generated code on the local chain, behind an explicit user click and the server's current run/confirmation eligibility. Use its generated deployment endpoint and keep handwritten reference actions in the reference demo.
- Describe only the payment rules the contract enforces.
