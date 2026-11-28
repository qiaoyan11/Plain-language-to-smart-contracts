# Replacing the hosted API with local fine-tuned models

The team plans to serve fine-tuned open models locally and use them in place of the hosted API. Each agent already accepts an OpenAI-compatible server, so the swap is configuration, not a code change. The browser never chooses the model.

## Configure an agent

| Agent | Settings | Request sent | Output the server must return |
| --- | --- | --- | --- |
| Agent 1 (clarify) | `AGENT1_BASE_URL`, `AGENT1_MODEL`, optional `AGENT1_API_KEY` | `/chat/completions`, JSON object mode | the clarification JSON described in `agent1/prompts.py` |
| Agent 2 (generate and repair) | `AGENT2_BASE_URL`, `AGENT2_MODEL`, optional `AGENT2_API_KEY` | `/chat/completions`, strict JSON schema `solidity_source` | `{"source": "<Solidity>"}` |
| Agent 3 (plan an operation) | `AGENT3_BASE_URL`, `AGENT3_MODEL`, optional `AGENT3_API_KEY` | `/chat/completions`, strict JSON schema `agent3_intent` | `{"kind", "milestoneId", "language"}` |

Use HTTPS, or plain HTTP only on `localhost`/`127.0.0.1`. Set the values in the shell that starts `npm run demo:web` (Agent 2's model name is also recorded by the Node backend in each run's `runConfig`). Without a base URL each agent keeps its pinned hosted model.

Example with vLLM serving a fine-tuned Agent 2 model:

```sh
vllm serve ./checkpoints/agent2-escrow --served-model-name escrow-coder-ft --port 8001
AGENT2_MODE=live AGENT2_BASE_URL=http://127.0.0.1:8001/v1 AGENT2_MODEL=escrow-coder-ft npm run demo:web
```

## What stays the same

- Agents still only propose. Node checks every rule, the validator compiles and tests the source, and the user confirms each transaction. A local model gets no extra authority.
- Output validation is shared: a local reply is converted to the same shape and checked by the same parser as the hosted API, so malformed, refused or truncated output fails the same way.
- Agent 3 keeps its 8-second model deadline and the 10-second bridge limit. A slower local model needs those limits raised deliberately.

## Comparing hosted and fine-tuned models

Run the same fixed cases against both configurations and report them side by side: Agent 1's acceptance scenarios (`agent1/README.md`), Agent 2's compile rate, Slither findings, clause-test pass rate and repair count, and Agent 3's 32 operation sentences (`agent3/cases`). Keep hidden evaluation cases out of fine-tuning data and prompts.
