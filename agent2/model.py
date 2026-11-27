"""One bounded model call: the hosted Responses API, or an OpenAI-compatible server set by
AGENT2_BASE_URL (for a locally served fine-tuned model). No SDK retries or model-chosen destinations."""
import json
import os
import time
import httpx
from dotenv import load_dotenv
from shared.handoff import ROOT
from shared.local_model import as_responses, chat_request, configured

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


def local_server():
    """The configured OpenAI-compatible server, or None for the hosted default."""
    load_dotenv(ROOT / '.env', override=False, interpolate=False)
    try:
        return configured('AGENT2')
    except ValueError as error:
        raise ModelError(f'MODEL_CONFIG: {error}') from None


def model_allowed(model):
    """Hosted runs use the pinned GPT-5.4 mini models; a local server runs only its configured model."""
    server = local_server()
    return model == server['model'] if server else model in ALLOWED_MODELS


def call_model(system, user, model):
    server = local_server()
    if not model_allowed(model):
        raise ModelError('MODEL_CONFIG: explicitly select the supported GPT-5.4 mini model, '
                         'or the AGENT2_MODEL served at AGENT2_BASE_URL.')
    if server:
        url = server['endpoint'] + '/chat/completions'
        key = server['key']
        body = chat_request(model, system, user, 'solidity_source', OUTPUT_SCHEMA, 8192)
    else:
        url = 'https://api.openai.com/v1/responses'
        key = os.getenv('OPENAI_API_KEY', '').strip()
        if not key:
            raise ModelError('MODEL_CONFIG: OPENAI_API_KEY is missing from the local environment/.env.')
        body = {'model': model, 'instructions': system, 'input': user, 'store': False,
                'reasoning': {'effort': 'medium'}, 'max_output_tokens': 8192,
                'text': {'format': {'type': 'json_schema', 'name': 'solidity_source',
                                    'strict': True, 'schema': OUTPUT_SCHEMA}}}
    headers = {'Authorization': 'Bearer ' + key} if key else {}
    start = time.monotonic()
    # No automatic retry: one invocation must mean one generation attempt.
    try:
        with httpx.Client(timeout=httpx.Timeout(150, connect=15), follow_redirects=False,
                          trust_env=not (server and server['loopback'])) as client:
            with client.stream('POST', url, headers=headers, json=body) as response:
                if response.status_code != 200:
                    raise ModelError(f'MODEL_HTTP_{response.status_code}: check API credentials, quota, and model access; no automatic retry.')
                chunks = bytearray()
                for chunk in response.iter_bytes():
                    chunks.extend(chunk)
                    if len(chunks) > 1024 * 1024:
                        raise ModelError('MODEL_SIZE: response exceeds 1 MiB.')
                data = json.loads(chunks)
                if server:
                    data = as_responses(data)
    except httpx.HTTPError:
        raise ModelError('MODEL_NETWORK: request failed or timed out; no automatic retry.') from None
    except (ValueError, TypeError):
        raise ModelError('MODEL_FORMAT: provider returned invalid JSON.') from None
    # Explicit allowlist: never persist HTTP headers or credentials.
    metadata = {'provider': f"openai-compatible:{server['host']}" if server else 'openai',
                'requestedModel': model, 'returnedModel': data.get('model'),
                'responseId': data.get('id'), 'usage': data.get('usage'),
                'elapsedSeconds': round(time.monotonic() - start, 3),
                'reasoningEffort': None if server else 'medium', 'maxOutputTokens': 8192, 'apiCalls': 1}
    try:
        source = read_output(data)
    except ModelError as error:
        return {'source': None, 'metadata': metadata, 'error': str(error)}
    return {'source': source, 'metadata': metadata, 'error': None}
