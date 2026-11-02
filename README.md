# Plain Language to Smart Contracts

An open-source project for turning plain-language service agreements into tested Solidity contracts and enabling wallet-authorized interactions.

## Workflow

Agreement → Agent 1 clarification → user confirmation → Agent 2 generation → verification and bounded repair → wallet-approved deployment → Agent 3 interaction and receipt checks.

## Modules

| Directory | Responsibility | Development branch |
| --- | --- | --- |
| agent1/ | Requirements, clarification, optional RAG | feature/agent1 |
| agent2/ | Solidity generation and repair | feature/agent2 |
| validation/ | Compilation, static analysis and clause tests | feature/validation |
| agent3/ | Deployment, queries and wallet-authorized operations | feature/agent3 |
| shared/ | Versioned interfaces and examples | Cross-module review |
| backend/ | Workflow and persistence | Shared |
| frontend/ | Input, confirmation and operation screens | Shared |

Module ownership is a collaboration convention, not folder-level access control. Each contributor integrates their own module.

## Roadmap

1. Agree on interfaces and refund rules.
2. Implement local reference-contract workflow.
3. Add generation, verification and repair.
4. Add public-testnet deployment and wallet interaction.
5. Publish reproducible evaluation and failure analysis.

## License

MIT; see LICENSE.
