"""One bounded Responses API call that classifies a client sentence. No retries."""
import json
import os
import time
import httpx
from dotenv import load_dotenv
from shared.handoff import ROOT

DEFAULT_MODEL = 'gpt-5.6-luna'
ALLOWED_MODELS = {DEFAULT_MODEL}
KINDS = ['query', 'deposit', 'acceptMilestone', 'unsupported', 'unclear']
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
    parts = [part for item in data.get('output', []) if item.get('type') == 'message'
             for part in item.get('content', [])]
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
    return {'kind': output['kind'], 'milestoneId': mid, 'language': output['language']}


def call_model(system, user, model=None):
    model = model or os.getenv('AGENT3_MODEL', DEFAULT_MODEL)
    if model not in ALLOWED_MODELS:
        raise ModelError('MODEL_CONFIG: unsupported model.')
    load_dotenv(ROOT / '.env', override=False, interpolate=False)
    key = os.getenv('OPENAI_API_KEY', '').strip()
    if not key:
        raise ModelError('MODEL_CONFIG: OPENAI_API_KEY is missing.')
    body = {'model': model, 'instructions': system, 'input': user, 'store': False,
            'reasoning': {'effort': 'low'}, 'max_output_tokens': 500,
            'text': {'format': {'type': 'json_schema', 'name': 'agent3_intent',
                                'strict': True, 'schema': OUTPUT_SCHEMA}}}
    start = time.monotonic()
    try:
        with httpx.Client(timeout=httpx.Timeout(8, connect=3), follow_redirects=False) as client:
            with client.stream('POST', 'https://api.openai.com/v1/responses',
                               headers={'Authorization': 'Bearer ' + key}, json=body) as response:
                if response.status_code != 200:
                    raise ModelError(f'MODEL_HTTP_{response.status_code}')
                chunks = bytearray()
                for chunk in response.iter_bytes():
                    chunks.extend(chunk)
                    if len(chunks) > 1024 * 1024:
                        raise ModelError('MODEL_SIZE: response exceeds 1 MiB.')
                data = json.loads(chunks)
    except httpx.HTTPError:
        raise ModelError('MODEL_NETWORK') from None
    except (ValueError, TypeError):
        raise ModelError('MODEL_FORMAT: provider returned invalid JSON.') from None
    if not isinstance(data, dict):
        raise ModelError('MODEL_FORMAT: provider returned invalid JSON.')
    parsed = read_output(data)
    # Explicit allowlist: never keep HTTP headers or credentials.
    metadata = {'model': data.get('model') or model, 'responseId': data.get('id'),
                'usage': data.get('usage'),
                'elapsedSeconds': round(time.monotonic() - start, 3)}
    return parsed, metadata
