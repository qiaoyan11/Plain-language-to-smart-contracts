"""One bounded model call that classifies a client sentence: the hosted Responses API, or an
OpenAI-compatible server set by AGENT3_BASE_URL (for a locally served fine-tuned model). No retries."""
import json
import os
import threading
import time
import httpx
from dotenv import load_dotenv
from shared.handoff import ROOT
from shared.local_model import as_responses, chat_request, configured

DEFAULT_MODEL = 'gpt-5.6-luna'
ALLOWED_MODELS = {DEFAULT_MODEL}
TOTAL_TIMEOUT_SECONDS = 8
KINDS = ['query', 'deposit', 'acceptMilestone', 'submitDelivery', 'requestChanges', 'claimMilestone', 'unsupported', 'unclear']
LANGUAGES = ['zh', 'en']
OUTPUT_SCHEMA = {
    'type': 'object',
    'properties': {
        'kind': {'type': 'string', 'enum': KINDS},
        'milestoneId': {'type': ['integer', 'null']},
        'language': {'type': 'string', 'enum': LANGUAGES},
    },
    'required': ['kind', 'milestoneId', 'language'],
    'additionalProperties': False,
}


class ModelError(RuntimeError):
    pass


def read_output(data):
    if data.get('status') != 'completed':
        raise ModelError('MODEL_INCOMPLETE: response did not finish.')
    items = data.get('output')
    if not isinstance(items, list):
        raise ModelError('MODEL_FORMAT: output is not a list.')
    parts = []
    for item in items:
        if not isinstance(item, dict):
            raise ModelError('MODEL_FORMAT: output item is not an object.')
        if item.get('type') != 'message':
            continue
        content = item.get('content')
        if not isinstance(content, list) or not all(isinstance(part, dict) for part in content):
            raise ModelError('MODEL_FORMAT: message content is malformed.')
        parts.extend(content)
    if any(part.get('type') == 'refusal' for part in parts):
        raise ModelError('MODEL_REFUSAL: the model refused.')
    text = ''.join(part.get('text', '') for part in parts if part.get('type') == 'output_text')
    try:
        output = json.loads(text)
    except (ValueError, TypeError):
        raise ModelError('MODEL_FORMAT: output is not JSON.') from None
    if not isinstance(output, dict) or set(output) != {'kind', 'milestoneId', 'language'}:
        raise ModelError('MODEL_FORMAT: unexpected keys.')
    if output['kind'] not in KINDS or output['language'] not in LANGUAGES:
        raise ModelError('MODEL_FORMAT: value outside the allowed set.')
    mid = output['milestoneId']
    if mid is not None and (isinstance(mid, bool) or not isinstance(mid, int) or mid < 1):
        raise ModelError('MODEL_FORMAT: milestoneId must be null or an integer >= 1.')
    # Accept the legacy classifier language values, but always render the operation in English.
    return {'kind': output['kind'], 'milestoneId': mid, 'language': 'en'}


def call_model(system, user, model=None):
    load_dotenv(ROOT / '.env', override=False, interpolate=False)
    try:
        server = configured('AGENT3')
    except ValueError as error:
        raise ModelError(f'MODEL_CONFIG: {error}') from None
    model = model or (server['model'] if server else os.getenv('AGENT3_MODEL', DEFAULT_MODEL))
    if (model != server['model']) if server else (model not in ALLOWED_MODELS):
        raise ModelError('MODEL_CONFIG: unsupported model.')
    if server:
        url, key = server['endpoint'] + '/chat/completions', server['key']
        body = chat_request(model, system, user, 'agent3_intent', OUTPUT_SCHEMA, 500)
    else:
        url, key = 'https://api.openai.com/v1/responses', os.getenv('OPENAI_API_KEY', '').strip()
        if not key:
            raise ModelError('MODEL_CONFIG: OPENAI_API_KEY is missing.')
        body = {'model': model, 'instructions': system, 'input': user, 'store': False,
                'reasoning': {'effort': 'low'}, 'max_output_tokens': 500,
                'text': {'format': {'type': 'json_schema', 'name': 'agent3_intent',
                                    'strict': True, 'schema': OUTPUT_SCHEMA}}}
    headers = {'Authorization': 'Bearer ' + key} if key else {}
    start = time.monotonic()

    def fetch():
        try:
            with httpx.Client(timeout=httpx.Timeout(8, connect=3), follow_redirects=False,
                              trust_env=not (server and server['loopback'])) as client:
                with client.stream('POST', url, headers=headers, json=body) as response:
                    if response.status_code != 200:
                        raise ModelError(f'MODEL_HTTP_{response.status_code}')
                    chunks = bytearray()
                    for chunk in response.iter_bytes():
                        chunks.extend(chunk)
                        if time.monotonic() - start > TOTAL_TIMEOUT_SECONDS:
                            raise ModelError('MODEL_NETWORK: total deadline exceeded.')
                        if len(chunks) > 1024 * 1024:
                            raise ModelError('MODEL_SIZE: response exceeds 1 MiB.')
                    data = json.loads(chunks)
                    return as_responses(data) if server else data
        except ModelError:
            raise
        except httpx.HTTPError:
            raise ModelError('MODEL_NETWORK') from None
        except (ValueError, TypeError):
            raise ModelError('MODEL_FORMAT: provider returned invalid JSON.') from None

    outcome = []

    def worker():
        try:
            outcome.append((True, fetch()))
        except BaseException as error:
            outcome.append((False, error))

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    thread.join(TOTAL_TIMEOUT_SECONDS)
    if thread.is_alive() or not outcome:
        raise ModelError('MODEL_NETWORK: deadline exceeded; no automatic retry.')
    ok, data = outcome[0]
    if not ok:
        if isinstance(data, ModelError):
            raise data
        raise ModelError('MODEL_NETWORK') from None
    if not isinstance(data, dict):
        raise ModelError('MODEL_FORMAT: provider returned invalid JSON.')
    parsed = read_output(data)
    # Explicit allowlist: never keep HTTP headers or credentials.
    metadata = {'model': data.get('model') or model, 'responseId': data.get('id'),
                'usage': data.get('usage'),
                'elapsedSeconds': round(time.monotonic() - start, 3)}
    return parsed, metadata
