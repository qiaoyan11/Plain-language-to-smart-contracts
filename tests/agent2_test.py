"""Offline tests: injected model replies, real compiler; never spend API credits."""
import copy
import json
import unittest
from unittest.mock import patch
import httpx
from shared.handoff import ROOT
from agent2.model import read_output, call_model, ModelError, DEFAULT_MODEL
from agent2.prompts import build_messages
from flows.generation import run_generation

REQUEST = json.loads((ROOT / 'agent2/examples/generate.request.json').read_text())
# Reference source used solely as a controlled test reply, never in the live prompt.
GOOD_SOURCE = (ROOT / 'contracts/MilestoneEscrow.sol').read_text().replace('contract MilestoneEscrow ', 'contract GeneratedMilestoneEscrow ')


def reply(source):
    return {'source': source, 'metadata': {'apiCalls': 1, 'usage': {'input_tokens': 10, 'output_tokens': 20}}, 'error': None}


def response_body(text=None, **extra):
    return {'status': 'completed', 'id': 'test-response', 'model': DEFAULT_MODEL,
            'usage': {'input_tokens': 10, 'output_tokens': 20},
            'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': text or json.dumps({'source': GOOD_SOURCE})}]}], **extra}


class Agent2Tests(unittest.TestCase):
    def setUp(self): self.request = copy.deepcopy(REQUEST)

    def test_real_compile_with_injected_model_is_not_independent_validation(self):
        calls = []
        def model(*args): calls.append(args); return reply(GOOD_SOURCE)
        run = run_generation(self.request, model_call=model)
        self.assertEqual(len(calls), 1)
        self.assertEqual(run['compilation']['status'], 'passed')
        self.assertEqual(run['response']['result']['status'], 'generated')
        self.assertIsNone(run['response']['result']['validationReport'])
        self.assertEqual(len(run['response']['result']['attempts']), 1)
        self.assertEqual(run['metadata']['usage']['output_tokens'], 20)

    def test_syntax_failure_does_not_trigger_hidden_retry(self):
        calls=[]
        def model(*args): calls.append(1); return reply('this is not Solidity')
        run=run_generation(self.request,model_call=model)
        self.assertEqual(len(calls),1)
        self.assertEqual(run['compilation']['status'],'failed')
        self.assertEqual(run['response']['result']['status'],'failed')
        self.assertIsNone(run['response']['result']['validationReport'])

    def test_model_cannot_import_local_files(self):
        run=run_generation(self.request,model_call=lambda *args:reply('pragma solidity 0.8.28; import "../.env";'))
        self.assertEqual(run['compilation']['status'],'failed')
        self.assertIsNone(run['compilation']['artifact'])

    def test_unsupported_modes_fail_before_model_call(self):
        for field,value in [('maxRepairs',1),('feedbackSetting','B'),('validationMode','development')]:
            request=copy.deepcopy(self.request);request['payload']['runConfig'][field]=value
            with self.subTest(field=field), self.assertRaises(ValueError):
                run_generation(request,model_call=lambda *args:self.fail('must not call model'))

    def test_tool_error_is_not_a_contract_failure(self):
        def unavailable(*args):raise ModelError('MODEL_NETWORK')
        run=run_generation(self.request,model_call=unavailable)
        self.assertEqual(run['response']['result']['status'],'toolError')
        self.assertIsNone(run['compilation'])

    def test_compiler_tool_error_cannot_pass(self):
        run=run_generation(self.request,model_call=lambda *args:reply(GOOD_SOURCE),
                           compiler=lambda *args:{'status':'toolError','artifact':None})
        self.assertEqual(run['response']['result']['status'],'toolError')

    def test_prompt_contains_rules_and_interface_not_reference_implementation(self):
        system,user=build_messages(self.request['payload']['spec'])
        self.assertIn('interface IMilestoneEscrow',user)
        self.assertIn(self.request['payload']['spec']['totalAmountWei'],user)
        self.assertNotIn('contract MilestoneEscrow',user)
        self.assertNotIn('hidden',user.lower())
        self.assertIn('Do not return validation reports',system)

    def test_model_report_injection_rejected(self):
        with self.assertRaises(ModelError):
            read_output(response_body(json.dumps({'source':GOOD_SOURCE,'status':'validated'})))

    def test_refusal_incomplete_and_empty_are_rejected(self):
        examples=[response_body(status='incomplete'),response_body('{}'),
                  response_body(output=[{'type':'message','content':[{'type':'refusal'}]}])]
        for data in examples:
            with self.subTest(data=data['status']),self.assertRaises(ModelError):read_output(data)

    def test_http_error_redacted_and_never_retried(self):
        calls=[]
        def handler(request):
            calls.append(request)
            return httpx.Response(401,json={'error':{'message':'do not log sensitive-provider-details'}})
        client=httpx.Client(transport=httpx.MockTransport(handler))
        with patch('agent2.model.load_dotenv'),patch.dict('os.environ',{'OPENAI_API_KEY':'test-key'}),patch('agent2.model.httpx.Client',return_value=client):
            with self.assertRaisesRegex(ModelError,'MODEL_HTTP_401') as error:call_model('system','user',DEFAULT_MODEL)
        self.assertEqual(len(calls),1)
        self.assertNotIn('test-key',str(error.exception))
        self.assertNotIn('sensitive-provider',str(error.exception))

    def test_responses_request_and_usage(self):
        def handler(request):
            data=json.loads(request.content)
            self.assertEqual(data['model'],DEFAULT_MODEL)
            self.assertFalse(data['store'])
            self.assertTrue(data['text']['format']['strict'])
            return httpx.Response(200,json=response_body())
        client=httpx.Client(transport=httpx.MockTransport(handler))
        with patch('agent2.model.load_dotenv'),patch.dict('os.environ',{'OPENAI_API_KEY':'test-key'}),patch('agent2.model.httpx.Client',return_value=client):
            result=call_model('system','user',DEFAULT_MODEL)
        self.assertEqual(result['source'],GOOD_SOURCE)
        self.assertEqual(result['metadata']['usage']['input_tokens'],10)
        self.assertNotIn('test-key',json.dumps(result))

    def test_incomplete_retains_usage_without_compiling(self):
        run=run_generation(self.request,model_call=lambda *args:{'source':None,'metadata':{'usage':{'output_tokens':8192}},'error':'MODEL_INCOMPLETE'},
                           compiler=lambda *args:self.fail('must not compile'))
        self.assertEqual(run['response']['result']['status'],'failed')
        self.assertEqual(run['metadata']['usage']['output_tokens'],8192)

    def test_live_worker_uses_service_and_preserves_public_envelope(self):
        from flows.worker import dispatch
        result = run_generation(self.request, model_call=lambda *args: reply(GOOD_SOURCE),
                                compiler=lambda *args: {'status': 'passed'})
        with patch.dict('os.environ', {'AGENT2_MODE': 'live'}), patch('agent2.service.run_generation', return_value=result) as service:
            response = dispatch(self.request)
        self.assertEqual(service.call_count, 1)
        self.assertEqual(response['requestId'], self.request['requestId'])
        self.assertEqual(response['result']['status'], 'generated')
        self.assertIsNone(response['result']['validationReport'])

if __name__=='__main__':unittest.main()
