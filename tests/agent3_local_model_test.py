"""Agent 3 with an OpenAI-compatible server, such as a locally served fine-tuned model. No network."""
import json
import unittest
from unittest.mock import patch

import httpx

from agent3.model import ModelError, call_model

LOCAL = {'AGENT3_BASE_URL': 'http://localhost:8001/v1', 'AGENT3_MODEL': 'escrow-intent-ft'}


def completion(content):
    return {'id': 'local-2', 'model': 'escrow-intent-ft',
            'choices': [{'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': content}}]}


class Agent3LocalModelTests(unittest.TestCase):
    def call(self, handler, env=LOCAL, model=None):
        client = httpx.Client(transport=httpx.MockTransport(handler))
        with patch('agent3.model.load_dotenv'), patch.dict('os.environ', env, clear=True), \
                patch('agent3.model.httpx.Client', return_value=client):
            return call_model('system', 'user', model)

    def test_classifies_through_the_configured_local_model(self):
        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(200, json=completion(json.dumps(
                {'kind': 'acceptMilestone', 'milestoneId': 1, 'language': 'en'})))
        parsed, metadata = self.call(handler)
        self.assertEqual(parsed, {'kind': 'acceptMilestone', 'milestoneId': 1, 'language': 'en'})
        self.assertEqual(str(seen[0].url), 'http://localhost:8001/v1/chat/completions')
        self.assertEqual(json.loads(seen[0].content)['model'], 'escrow-intent-ft')
        self.assertEqual(metadata['model'], 'escrow-intent-ft')

    def test_rejects_invalid_local_output_and_other_models(self):
        with self.assertRaises(ModelError):
            self.call(lambda request: httpx.Response(200, json=completion('{"kind": "pay everything"}')))
        with self.assertRaisesRegex(ModelError, 'MODEL_CONFIG'):
            self.call(lambda request: self.fail('must not send'), model='gpt-5.6-luna')
        with self.assertRaisesRegex(ModelError, 'MODEL_CONFIG'):
            self.call(lambda request: self.fail('must not send'),
                      env={'AGENT3_BASE_URL': 'http://10.0.0.2:8001/v1', 'AGENT3_MODEL': 'x'})


if __name__ == '__main__':
    unittest.main()
