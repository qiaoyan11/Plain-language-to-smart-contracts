import json
import os
import unittest
from unittest.mock import patch

import httpx

from agent1.model import extract

PAYLOAD = {'message': 'Logo for $800', 'history': [], 'draftSpec': None}


def completion():
    return {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps({'name': 'Logo'})}}]}


class TransportTests(unittest.TestCase):
    def run_with(self, replies):
        calls = []
        def handler(request):
            calls.append(request)
            item = replies[min(len(calls), len(replies)) - 1]
            if isinstance(item, Exception):
                raise item
            return item
        client = httpx.Client(transport=httpx.MockTransport(handler))
        env = {k: v for k, v in os.environ.items() if not k.startswith('AGENT1_')}
        env['OPENAI_API_KEY'] = 'test-key'
        with patch('agent1.model.load_dotenv'), patch.dict('os.environ', env, clear=True), \
                patch('agent1.model.httpx.Client', return_value=client), patch('agent1.model.time.sleep'):
            try:
                return extract('system', PAYLOAD), calls
            except Exception as error:
                return error, calls

    def test_one_quick_resend_when_turned_away(self):
        for first in (httpx.Response(503), httpx.Response(429), httpx.ConnectError('down')):
            with self.subTest(first=type(first).__name__):
                result, calls = self.run_with([first, httpx.Response(200, json=completion())])
                self.assertEqual((result, len(calls)), ({'name': 'Logo'}, 2))

    def test_no_resend_for_quota_timeouts_or_a_second_refusal(self):
        quota = httpx.Response(429, json={'error': {'code': 'insufficient_quota'}})
        for replies, count in [([quota], 1), ([httpx.ReadTimeout('slow')], 1), ([httpx.Response(503)], 2),
                               ([httpx.Response(401)], 1)]:
            with self.subTest(count=count, first=replies[0]):
                result, calls = self.run_with(replies)
                self.assertIsInstance(result, Exception)
                self.assertEqual(len(calls), count)


if __name__ == '__main__':
    unittest.main()
