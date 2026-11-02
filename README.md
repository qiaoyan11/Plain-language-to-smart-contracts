# Plain Language to Smart Contracts

An open-source project for turning plain-language service agreements into tested Solidity contracts and enabling wallet-authorized interactions.

## Status

Early development scaffold. No runnable agent, contract, wallet integration or deployment is implemented yet. Test networks only; not an audited production system.

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

## Getting started

Read CONTRIBUTING.md and shared/INTERFACES.md. Agree on the specification before implementing. Begin with one client, one provider, two payment stages and one explicit refund policy. Use reference inputs and a hand-written local contract while agents are incomplete.

## Roadmap

1. Agree on interfaces and refund rules.
2. Implement local reference-contract workflow.
3. Add generation, verification and repair.
4. Add public-testnet deployment and wallet interaction.
5. Publish reproducible evaluation and failure analysis.

## Contributing

Open an issue to discuss changes, then submit a focused pull request. Outside contributors can fork the repository. Never upload credentials, private agreements or real-money keys.

## Prior work

Reference: https://github.com/AgenticsFintekColumbia/smart-contracts

No upstream code is included in this scaffold. Record source revisions, licenses and inherited code before reuse.

## License

MIT; see LICENSE.
