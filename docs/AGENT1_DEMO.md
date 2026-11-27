# Local demo: the first milestone payment

The client hires a developer to build a website for 0.01 test ETH. The homepage earns 30% and the complete site earns 70%. The client deposits the full amount once and approves each payment in order. This walkthrough ends after the homepage payment.

## Start the app

Follow the [frontend setup](../frontend/README.md). Configure the model credentials in the local `.env`. From the repository root, start the backend with `AGENT1_MODE=live AGENT2_MODE=live AGENT3_MODE=live npm run backend`. Then run `npm run dev` from `frontend/` and open `http://127.0.0.1:5173/`. Live model calls can incur charges. Payments use disposable test accounts on a local Hardhat chain.

## Walkthrough

1. Start a new agreement and paste this request. Leave both wallets out to exercise the assistant's follow-up questions.

   > Project: Studio website. I am hiring a developer for 0.01 test ETH. I will deposit the full amount upfront. Pay 30% after I approve the homepage against the agreed design, and 70% after I approve the complete site against the agreed checkout tests. Pay the milestones in that order.

2. Agent 1 summarizes the payments as **0.003** and **0.007 test ETH**. Answer the funding-wallet question with the local client address. When the assistant asks for the provider's wallet, enter the local developer address. The local account shortcut can supply both at once.
3. Select **Review agreement**. Check the two amounts and both addresses. If the client stops approving payments after the first milestone, the remaining **0.007 test ETH can stay locked indefinitely**. This version supports neither refunds nor automatic release. Acknowledge the scope and confirm the agreement.
4. Generate and check the contract. Agent 2 sends the generated source through compilation, static analysis and payment-rule tests. Deploy the validated version to the local chain once all required checks pass.
5. Choose the **deposit** button. Verify the amount is **0.01 test ETH** and the recipient is the deployed escrow contract. Confirm the deposit and wait for its receipt.
6. Choose the **milestone 1 payment** button. Verify the amount is **0.003 test ETH** and the recipient is the developer's wallet. Confirm only this payment. The button plans the operation directly. Agent 3's English text input is also available.
7. Refresh the project. Verify the homepage is **Paid**, the complete site is **Unpaid**, and the escrow balance is **0.007 test ETH**. Expand the transaction history to see deployment, deposit and one milestone payment.

### English browser run on November 27

Agent 1 asked for the client wallet, then the provider wallet. Agent 2 passed compilation, static analysis and all 24 payment-rule tests after one repair. The browser showed the following receipts on local chain 31337. After a refresh, the balance was 0.007 test ETH and milestone 2 was still unpaid.

| Local block | Action | Transaction |
| --- | --- | --- |
| 2 | Deposit 0.01 test ETH | `0x28b08949cdc8da8572d0dc1abe7675408db242db60e66f8496be5c6cc7ece48a` |
| 3 | Pay 0.003 test ETH to the developer | `0x8dbed2af38d8b661d5d5738424fbffcfd30567ef825d0fdfede0ade14e1a47ac` |

<a id="走一次流程"></a>

The [earlier November 27 walkthrough](https://github.com/qiaoyan11/Plain-language-to-smart-contracts/blob/ab383c8/docs/AGENT1_DEMO.md) contains the receipts referenced in the previous worklog entry.

## What the app records

The backend keeps the agreement text, each clarification, the confirmed rules and the chain receipts. The browser restores a draft by ID. A failed message can be retried with its original request key. Once a draft is confirmed, a new agreement is needed to change its terms. Restarting the backend clears the local drafts, projects and chain.

System messages and test scenarios are in English. The original agreement text, user-entered names and exact quotes remain available for review. An unsupported payment condition keeps the agreement in draft until the user resolves it. Separate written obligations are recorded outside the on-chain rules.

## Integration notes

The browser calls the Node draft API. Node keeps the conversation and sends the actual follow-up question to Agent 1 with the next answer. Explicit confirmation binds the rules to a project version. Agent 2 generates from those rules. Both the direct payment buttons and Agent 3's natural-language requests use the same transaction confirmation and receipt checks. The handwritten-contract demo remains at `/reference-demo`.

The intake and review flow draws on the [Ironclad intake](https://legal.ironcladapp.com/fy2026-product-descriptions), [Juro contract summary](https://juro.com/product-updates/september-2026) and [Escrow.com milestone flow](https://www.escrow.com/milestones/how-it-works). For exact input and output fields, see the [shared interfaces](../shared/INTERFACES.md). For an earlier complete two-payment run, see the [November 26 run record](DEMO_RUN_2026-11-26.md).
