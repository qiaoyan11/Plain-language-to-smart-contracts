"""OpenAI-compatible chat transport. Configure the endpoint on the server."""
import json
import os
from urllib.parse import urlsplit

import httpx
from dotenv import load_dotenv
from shared.handoff import ROOT


def extract(instructions, payload):
    load_dotenv(ROOT / '.env', override=False, interpolate=False)
    endpoint = os.getenv('AGENT1_BASE_URL', 'https://api.openai.com/v1').rstrip('/')
    location = urlsplit(endpoint)
    local = location.hostname in {'localhost', '127.0.0.1', '::1'}
    if location.scheme != 'https' and not (local and location.scheme == 'http'):
        raise ValueError('Use HTTPS or a loopback HTTP model server.')
    hosted = endpoint == 'https://api.openai.com/v1'
    key = os.getenv('AGENT1_API_KEY') or (os.getenv('OPENAI_API_KEY') if hosted else None)
    model = os.getenv('AGENT1_MODEL') or ('gpt-5.4-mini' if hosted else None)
    if not model or (hosted and not key):
        raise ValueError('Configure the Agent 1 model and credentials.')
    # A reply such as "0.08" directly follows the assistant turn that asked for ETH.
    # Keep the draft alongside the new message as data, separate from the quoted chat history.
    current_turn = {'message': payload['message'], 'draftSpec': payload['draftSpec']}
    body = {'model': model, 'messages': [
        {'role': 'system', 'content': instructions},
        *payload['history'],
        {'role': 'user', 'content': json.dumps(current_turn, ensure_ascii=False)}],
        'response_format': {'type': 'json_object'}}
    headers = {'Authorization': f'Bearer {key}'} if key else {}
    with httpx.Client(timeout=45, follow_redirects=False, trust_env=not local) as client:
        response = client.post(endpoint + '/chat/completions', headers=headers, json=body)
        if response.status_code != 200:
            raise RuntimeError(f'Agent 1 model returned HTTP {response.status_code}')
        choice = response.json()['choices'][0]
    if choice['finish_reason'] != 'stop':
        raise ValueError('Model did not finish the extraction.')
    return json.loads(choice['message']['content'])
