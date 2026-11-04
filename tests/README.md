# Development and integration tests

| Command | Coverage |
| --- | --- |
| `npm test` | Reference contracts on the local EVM: permissions, exact amounts, ordering, duplicates and recipient failures |
| `npm run test:api` | Reference HTTP lifecycle plus explicit confirmation, version changes, async generation, duplicate requests and failure handling |
| `npm run e2e` | Python/Node handoff formats and bridge process handling; fixture-based, not a full AI product test |
| `npm run test:agent2` | Agent 2 workflow, validation feedback and repair limits with controlled dependencies |

`generation-api.test.cjs` injects controlled worker responses and checks the actual HTTP endpoints. Its synthetic reports are test fixtures, not independent validation evidence. One case uses the real Python bridge in stub mode to check error propagation. These tests never invoke a paid model; they do not establish the quality of generated contracts.

Independent validation tests are maintained by Claude in `validation/` (`npm run test:validation`). Final evaluation cases remain separate from development feedback. Public-testnet signing and wallet approval are not implemented or covered here.
