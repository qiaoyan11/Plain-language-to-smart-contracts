# Agent 1 · Agreement drafting

Agent 1 guides a client and provider from a service description to an editable milestone-payment worksheet and a v1 JSON draft. Run it independently before connecting the frontend. A human reviews and confirms the draft through the existing Node confirmation flow. Agent 2 consumes that confirmed spec and the server's matching confirmation record.

## Run

From the repository root, use the project's Python environment (Python 3.11+ with the locked dependencies installed). No new packages are required.

```sh
# Check deterministic behavior without an account or model download.
python -m unittest agent1.test_service -v

# Hosted model. Set OPENAI_API_KEY in the process environment first.
export AGENT1_MODE=live
python -m agent1.chat

# One request from a file, through the same worker used by the bridge.
python -m agent1 shared/examples/clarify.request.json
python -m agent1 shared/examples/clarify.request.json --template
```

In chat, enter the agreement and type `/end` on its own line. Answer the questions and type `/end` again. Type `/quit` to finish. Chat calls the live adapter and keeps history in memory for the session. The one-request CLI defaults to the repository fixture unless `AGENT1_MODE=live`. Use the JSON CLI for the teammate integrating Agent 2, or `--template` for a party reviewing the agreement.

To switch to a local OpenAI-compatible chat-completions server, set its URL and the model name served there. It must support JSON-object responses.

```sh
export AGENT1_MODE=live
export AGENT1_BASE_URL=http://127.0.0.1:8000/v1
export AGENT1_MODEL=your-served-model-name
python -m agent1.chat
```

The hosted default is gpt-5.4-mini. A custom endpoint can use AGENT1_API_KEY. The default provider's OPENAI_API_KEY is never automatically forwarded to a custom URL. Model failures surface as errors and make no confirmation record.

## When the client keeps requesting changes

For “pay 30% for the homepage, but revise until the client is happy”, Agent 1 should ask both parties what demonstrates acceptance (for example, a named mockup), which defects are included, how many consolidated revision rounds are included, who reviews resubmission and by when, and how they escalate a disagreement. A new page or feature can be a separately priced change order if both parties choose that option. The parties decide what happens to the disputed 30% and to later work.

V1 only pays on sequential client approval. A revision cap, arbitrator payout, automatic release after silence or cancellation refund cannot be enforced by this interface. If the parties require one of these in the generated contract, the response remains unsupported. If they elect to document a safeguard separately, the readable worksheet keeps the agreed wording as user-sourced quotations for their separate written agreement. The v1 JSON passed to Agent 2 carries only the on-chain payment schedule. Unresolved protections should remain visible as questions or unsupported terms. The worksheet shows the risk of locked funds. A clear supported schedule can proceed directly to human review.

## Integration and examples

Send `{message, history, draftSpec}` as the payload of a v1 clarify envelope. On follow-up, pass the previous draft and the full conversation, including the previous result serialized as an assistant JSON message. This preserves unsupported terms across unrelated follow-ups. Initial drafts get a new project ID; seed draftSpec if the app already owns the ID. Edited drafts keep the ID and increase specVersion. Node owns the final authoritative project, version and confirmation record.

Previously unresolved questions stay open until the current user answers them. The extractor's internal `resolvedQuestions` entries contain the prior `field` and an exact current `userQuote`. A single bare amount, percentage or wallet can also fill the missing value addressed by the previous displayed question after exact parsing and source checks, even if the model repeats that missing-value question. Values merely mentioned among alternatives cannot clear ambiguity. An unresolved total stays null even if old installments can be summed. Other answers still require semantic interpretation; the program does not infer consent from keywords.

The web backend keeps all blockers internally but records only one primary question per successful turn, together with a reply derived from actual draft changes. It includes that displayed `question` in the next assistant history envelope so a bare address answers the correct role. Chinese conversations keep Chinese replies even for number-only follow-ups. Exact source quotes such as `0.01 测试 ETH`, `30%` and `30％` are supported; negated requirements such as “不需要退款” are not affirmative refund requests. This language interpretation still depends on the extraction model.

Live `clarify` results also include `separateTerms`, an optional list in the shared schema, so the worker and app can retain the quoted off-chain terms. These terms stay outside `draftSpec` and do not become Agent 2 payment rules. `draft_agreement` retains its `(result, notes)` interface for the standalone worksheet. Old fixtures without `separateTerms` remain valid.

| Example in examples/ | Expected result |
| --- | --- |
| complete.json | 1 ETH split 30/70 with objective deliverables; ready for human confirmation |
| missing-amount.json | Missing budget and installment amounts; ask the parties |
| revisions.json | Open-ended changes; ask about evidence, boundaries, review and dispute handling |
| refund.json | Late-delivery refund requested; report unsupported |

Each example contains the request, a **scripted** model extraction and expected result. The example project ID is fixed for reproducible comparisons. Extract the request to exercise an actual model:

```sh
python -c "import json; print(json.dumps(json.load(open('agent1/examples/revisions.json'))['request']))" > /tmp/agent1-request.json
AGENT1_MODE=live python -m agent1 /tmp/agent1-request.json --template
```

The deterministic layer checks wallet and amount evidence, computes exact wei from percentages, checks totals and validates both boundaries with shared.handoff. Semantic interpretation (including whether a requested protection was withdrawn) depends on the configured model. The regression suite includes a loopback HTTP model double to exercise the transport and worker; it does not measure a real model's extraction accuracy. Frontend wiring, contract extensions and final deployment remain separate integration tasks.

### Demo: detect a risk the parties did not name

Use the revisions example without telling Agent 1 that the provider might never get paid.
Common English and Chinese clauses such as “until the client is satisfied” and “修改至甲方满意”
trigger a question about acceptance evidence even when the extractor overlooks the risk.
Try supplying a wallet next: that unrelated answer leaves the question open. Then give the
actual replacement agreement. If the parties want a timeout payout, the current v1 capability
check must still identify it as unsupported. Wider paraphrase coverage and semantic interpretation
of a reply depend on the model.
