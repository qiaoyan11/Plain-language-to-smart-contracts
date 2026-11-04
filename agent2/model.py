"""One bounded Responses API call. No SDK retries or model-chosen destinations."""
import json
import os
import time
import httpx
from dotenv import load_dotenv
from shared.handoff import ROOT

DEFAULT_MODEL = 'gpt-5.4-mini-2026-03-17'
ALLOWED_MODELS = {DEFAULT_MODEL, 'gpt-5.4-mini'}
OUTPUT_SCHEMA = {'type': 'object', 'properties': {'source': {'type': 'string'}},
                 'required': ['source'], 'additionalProperties': False}


class ModelError(RuntimeError):
    pass


def read_output(data):
    if data.get('status') != 'completed':
        raise ModelError('MODEL_INCOMPLETE: response did not finish; no automatic retry.')
    parts = [part for item in data.get('output', []) if item.get('type') == 'message'
             for part in item.get('content', [])]
    if any(part.get('type') == 'refusal' for part in parts):
        raise ModelError('MODEL_REFUSAL: no contract returned.')
    text = ''.join(part.get('text', '') for part in parts if part.get('type') == 'output_text')
    try:
        output = json.loads(text)
    except (ValueError, TypeError):
        raise ModelError('MODEL_FORMAT: output is not JSON.') from None
    if not isinstance(output, dict) or set(output) != {'source'} or not isinstance(output['source'], str) or not output['source'].strip():
        raise ModelError('MODEL_FORMAT: expected only a nonempty source string.')
    if len(output['source'].encode()) > 128 * 1024:
        raise ModelError('MODEL_SIZE: source exceeds 128 KiB.')
    return output['source']


def call_model(system, user, model):
    if model not in ALLOWED_MODELS:
        raise ModelError('MODEL_CONFIG: explicitly select the supported GPT-5.4 mini model.')
    load_dotenv(ROOT / '.env', override=False, interpolate=False)
    key = os.getenv('OPENAI_API_KEY', '').strip()
    if not key:
        raise ModelError('MODEL_CONFIG: OPENAI_API_KEY is missing from the local environment/.env.')
    body = {'model': model, 'instructions': system, 'input': user, 'store': False,
            'reasoning': {'effort': 'medium'}, 'max_output_tokens': 8192,
            'text': {'format': {'type': 'json_schema', 'name': 'solidity_source',
                                'strict': True, 'schema': OUTPUT_SCHEMA}}}
    start = time.monotonic()
    # No automatic retry: one invocation must mean one generation attempt.
    try:
        with httpx.Client(timeout=httpx.Timeout(150, connect=15), follow_redirects=False) as client:
            with client.stream('POST', 'https://api.openai.com/v1/responses',
                               headers={'Authorization': 'Bearer ' + key}, json=body) as response:
                if response.status_code != 200:
                    raise ModelError(f'MODEL_HTTP_{response.status_code}: check API credentials, quota, and model access; no automatic retry.')
                chunks = bytearray()
                for chunk in response.iter_bytes():
                    chunks.extend(chunk)
                    if len(chunks) > 1024 * 1024:
                        raise ModelError('MODEL_SIZE: response exceeds 1 MiB.')
                data = json.loads(chunks)
    except httpx.HTTPError:
        raise ModelError('MODEL_NETWORK: request failed or timed out; no automatic retry.') from None
    except (ValueError, TypeError):
        raise ModelError('MODEL_FORMAT: provider returned invalid JSON.') from None
    # Explicit allowlist: never persist HTTP headers or credentials.
    metadata = {'provider': 'openai', 'requestedModel': model, 'returnedModel': data.get('model'),
                'responseId': data.get('id'), 'usage': data.get('usage'),
                'elapsedSeconds': round(time.monotonic() - start, 3),
                'reasoningEffort': 'medium', 'maxOutputTokens': 8192, 'apiCalls': 1}
    try:
        source = read_output(data)
    except ModelError as error:
        return {'source': None, 'metadata': metadata, 'error': str(error)}
    return {'source': source, 'metadata': metadata, 'error': None}
