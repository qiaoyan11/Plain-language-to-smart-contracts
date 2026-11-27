"""Optional OpenAI-compatible model server for an agent, such as a locally served fine-tuned model.

Setting <AGENT>_BASE_URL switches that agent from the hosted Responses API to `/chat/completions`
on the given server with <AGENT>_MODEL. The reply is converted to the Responses shape so each
agent keeps a single output validator. Credentials and headers are never returned.
"""
import os
from urllib.parse import urlsplit

LOOPBACK = {'localhost', '127.0.0.1', '::1'}


def configured(prefix):
    """Return the server settings for AGENT1/AGENT2/AGENT3, or None to use the hosted default."""
    base = os.getenv(f'{prefix}_BASE_URL', '').strip().rstrip('/')
    if not base:
        return None
    location = urlsplit(base)
    loopback = location.hostname in LOOPBACK
    if location.scheme != 'https' and not (loopback and location.scheme == 'http'):
        raise ValueError(f'{prefix}_BASE_URL must use HTTPS or a loopback HTTP model server.')
    model = os.getenv(f'{prefix}_MODEL', '').strip()
    if not model:
        raise ValueError(f'Set {prefix}_MODEL to the model name served at {prefix}_BASE_URL.')
    return {'endpoint': base, 'model': model, 'key': os.getenv(f'{prefix}_API_KEY', '').strip() or None,
            'loopback': loopback, 'host': location.hostname}


def chat_request(model, system, user, name, schema, max_tokens):
    """A strict JSON-schema chat request; servers such as vLLM enforce it with guided decoding."""
    return {'model': model, 'max_tokens': max_tokens,
            'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
            'response_format': {'type': 'json_schema',
                                'json_schema': {'name': name, 'strict': True, 'schema': schema}}}


def as_responses(data):
    """Convert one chat completion to the Responses fields the agents already validate."""
    if not isinstance(data, dict) or not isinstance(data.get('choices'), list) or not data['choices']:
        return {'status': 'failed', 'output': []}
    choice = data['choices'][0]
    message = choice.get('message') if isinstance(choice, dict) else None
    if not isinstance(message, dict):
        return {'status': 'failed', 'output': []}
    content = []
    if message.get('refusal'):
        content.append({'type': 'refusal', 'refusal': message['refusal']})
    if isinstance(message.get('content'), str):
        content.append({'type': 'output_text', 'text': message['content']})
    return {'status': 'completed' if choice.get('finish_reason') == 'stop' else 'incomplete',
            'output': [{'type': 'message', 'content': content}],
            'model': data.get('model'), 'id': data.get('id'), 'usage': data.get('usage')}
