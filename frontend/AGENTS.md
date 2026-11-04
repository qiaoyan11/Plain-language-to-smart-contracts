# Frontend collaboration

- Follow the repository AGENTS.md and shared HTTP contracts.
- Keep page data access in src/api/client.ts. Never fall back to simulated success after an HTTP error.
- Preserve the reference-demo routes and distinguish them from AI-generated contracts.
- Clarification is not connected to a real Agent 1 yet; label scripted guidance honestly.
- Conversation text and supplementary terms stay in browser storage, separate from payment API payloads.
- Do not claim unsupported terms are enforced, or enable generated-code deployment.
