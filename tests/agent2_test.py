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
        for field,value in [('maxRepairs',1),('feedbackSetting','B'),('maxRepairs',6)]:
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
        with patch.dict('os.environ', {'AGENT2_MODE': 'live'}), patch('agent2.service.run_and_save', return_value=(result, {'runDirectory': 'offline-test'})) as service:
            response = dispatch(self.request)
        self.assertEqual(service.call_count, 1)
        self.assertEqual(response['requestId'], self.request['requestId'])
        self.assertEqual(response['result']['status'], 'generated')
        self.assertIsNone(response['result']['validationReport'])




def development_request(setting='B', repairs=1):
    request = copy.deepcopy(REQUEST)
    request['payload']['runConfig'].update(validationMode='development', feedbackSetting=setting, maxRepairs=repairs)
    return request


def fake_report(bundle, failing=(), tools=()):
    """Controlled report for workflow tests only; never evidence for deployment."""
    checks = []
    for name in ('compilation', 'staticAnalysis', 'clauseTests'):
        status = 'toolError' if name in tools else 'failed' if name in failing else 'passed'
        checks.append({'name': name, 'status': status, 'findings': [] if status == 'passed' else
                       [{'code': name + '_CODE', 'severity': 'error', 'message': name + '_SECRET', 'file': None, 'line': None}]})
    passed = not failing and not tools
    return {'reportId': 'test-' + bundle['sourceHash'][-12:], 'projectId': bundle['projectId'],
            'specVersion': bundle['specVersion'], 'sourceHash': bundle['sourceHash'], 'suiteVersion': 'offline-test-only',
            'mode': 'development', 'status': 'passed' if passed else 'failed' if failing else 'toolError', 'checks': checks,
            'artifact': {'abi': [], 'bytecode': '0x00', 'compilerVersion': bundle['compilerVersion'],
                         'buildSettings': bundle['buildSettings'], 'sourceHash': bundle['sourceHash'],
                         'constructorTypes': ['address', 'address', 'uint256[]']} if passed else None}


class RepairTests(unittest.TestCase):
    def test_a_validates_but_never_repairs(self):
        calls=[]
        def model(*args): calls.append(args); return reply(GOOD_SOURCE)
        run=run_generation(development_request('A',0),model_call=model,
                           validator=lambda spec,b:fake_report(b,('staticAnalysis',)))
        self.assertEqual(len(calls),1)
        self.assertEqual(run['response']['result']['status'],'failed')
        self.assertEqual(run['stopReason'],'no_repairs')

    def test_b_filters_clause_feedback_c_includes_it(self):
        for setting in ('B','C'):
            with self.subTest(setting=setting):
                calls=[]
                def model(*args): calls.append(args); return reply(GOOD_SOURCE + '\n' * len(calls))
                def validator(spec,b):
                    return fake_report(b,('staticAnalysis','clauseTests') if len(calls)==1 else ())
                run=run_generation(development_request(setting),model_call=model,validator=validator)
                result=run['response']['result']
                self.assertEqual(len(calls),2)
                self.assertEqual(result['status'],'validated')
                self.assertIn('staticAnalysis_SECRET',calls[1][1])
                self.assertEqual('clauseTests_SECRET' in calls[1][1],setting=='C')
                self.assertNotIn('bytecode',calls[1][1])
                self.assertEqual(result['attempts'][-1]['reportId'],result['validationReport']['reportId'])
                self.assertEqual(len(run['history']),2)
                self.assertEqual(len(run['modelCalls']),2)
                self.assertEqual(run['metadata']['usage']['input_tokens'],20)
                self.assertNotEqual(run['history'][0]['sourceBundle']['sourceHash'],result['sourceBundle']['sourceHash'])
                if setting=='B':self.assertFalse(any('clause' in f for f in result['attempts'][1]['feedbackUsed']))

    def test_budget_exhaustion_and_no_retry_after_failed_repair(self):
        calls=[]
        def model(*args):calls.append(1);return reply(GOOD_SOURCE)
        run=run_generation(development_request(repairs=2),model_call=model,
                           validator=lambda spec,b:fake_report(b,('compilation',)))
        self.assertEqual(len(calls),3)
        self.assertEqual(len(run['response']['result']['attempts']),3)
        self.assertEqual(run['stopReason'],'repair_budget_exhausted')
        self.assertEqual(run['response']['result']['status'],'failed')

    def test_b_stops_when_only_clause_test_fails(self):
        calls=[]
        def model(*args):calls.append(1);return reply(GOOD_SOURCE)
        run=run_generation(development_request(),model_call=model,
                           validator=lambda spec,b:fake_report(b,('clauseTests',)))
        self.assertEqual(len(calls),1)
        self.assertEqual(run['stopReason'],'no_eligible_feedback')
        self.assertEqual(run['response']['result']['status'],'failed')

    def test_mixed_code_and_tool_failure_always_stops(self):
        calls=[]
        def model(*args):calls.append(1);return reply(GOOD_SOURCE)
        run=run_generation(development_request('C'),model_call=model,
                           validator=lambda spec,b:fake_report(b,('clauseTests',),('staticAnalysis',)))
        self.assertEqual(len(calls),1)
        self.assertEqual(run['response']['result']['status'],'toolError')
        self.assertEqual(run['stopReason'],'tool_error')

    def test_missing_validator_or_wrong_report_cannot_pass_or_repair(self):
        def unavailable(*args):raise ImportError('sensitive implementation details')
        def mismatch(spec,b):
            report=fake_report(b);report['sourceHash']='sha256:'+'0'*64;return report
        for validator in (unavailable,mismatch,lambda *args:{'status':'passed'}):
            calls=[]
            def model(*args):calls.append(1);return reply(GOOD_SOURCE)
            run=run_generation(development_request(),model_call=model,validator=validator)
            self.assertEqual(len(calls),1)
            self.assertEqual(run['response']['result']['status'],'toolError')
            self.assertIsNone(run['response']['result']['validationReport'])
            self.assertNotIn('sensitive implementation',json.dumps(run))

    def test_compilation_failure_can_be_repaired_through_trusted_validation(self):
        calls=[]
        def model(*args):calls.append(args);return reply('bad Solidity' if len(calls)==1 else GOOD_SOURCE)
        def validator(spec,b):return fake_report(b,('compilation',) if len(calls)==1 else ())
        run=run_generation(development_request(),model_call=model,validator=validator,
                           compiler=lambda *args:self.fail('development must use independent recompiler'))
        self.assertEqual(run['response']['result']['status'],'validated')
        self.assertIn('compilation_SECRET',calls[1][1])

    def test_resume_revalidates_original_and_preserves_input(self):
        seed=run_generation(REQUEST,model_call=lambda *args:reply(GOOD_SOURCE),compiler=lambda *args:{'status':'passed'})['response']['result']['sourceBundle']
        before=copy.deepcopy(seed);checks=[];calls=[];events=[]
        def validator(spec,b):checks.append(b['sourceHash']);return fake_report(b,('staticAnalysis',) if len(checks)==1 else ())
        def model(*args):calls.append(1);return reply(GOOD_SOURCE+'\n// repaired')
        run=run_generation(development_request(),initial_bundle=seed,model_call=model,validator=validator,on_record=events.append)
        self.assertEqual(seed,before)
        self.assertEqual(len(checks),2)
        self.assertEqual(len(calls),1)
        self.assertTrue(run['resumedSource'])
        self.assertEqual(run['metadata']['apiCalls'],1)
        self.assertEqual(run['history'][0]['sourceBundle'],seed)
        self.assertEqual([e['kind'] for e in events],['source','validation','modelCall','source','validation'])

    def test_repair_model_failure_keeps_previous_source_report_and_call_usage(self):
        calls=[]
        def model(*args):
            calls.append(1)
            return reply(GOOD_SOURCE) if len(calls)==1 else {'source':None,'metadata':{'usage':{'output_tokens':8192},'apiCalls':1},'error':'MODEL_INCOMPLETE'}
        run=run_generation(development_request(),model_call=model,validator=lambda spec,b:fake_report(b,('staticAnalysis',)))
        result=run['response']['result']
        self.assertEqual(result['status'],'failed')
        self.assertEqual(len(result['attempts']),1)
        self.assertIsNotNone(result['validationReport'])
        self.assertEqual(len(run['modelCalls']),2)
        self.assertEqual(run['metadata']['usage']['output_tokens'],8212)
        self.assertEqual(run['stopReason'],'model_error')

    def test_real_validator_checks_injected_source_and_returns_its_artifact(self):
        run=run_generation(development_request('A',0),model_call=lambda *args:reply(GOOD_SOURCE))
        result=run['response']['result']
        self.assertEqual(result['status'],'validated',run)
        report=result['validationReport']
        self.assertEqual({c['status'] for c in report['checks']},{'passed'})
        self.assertIn('slither-block-high-medium-v1',report['suiteVersion'])
        self.assertGreater(len(report['artifact']['bytecode']),1000)
        self.assertEqual(report['artifact']['sourceHash'],result['sourceBundle']['sourceHash'])
        self.assertEqual(result['attempts'][0]['reportId'],report['reportId'])

    def test_passed_first_attempt_stops_with_budget_remaining(self):
        calls=[]
        def model(*args):calls.append(1);return reply(GOOD_SOURCE)
        run=run_generation(development_request('C',5),model_call=model,validator=lambda spec,b:fake_report(b))
        self.assertEqual(len(calls),1)
        self.assertEqual(run['response']['result']['status'],'validated')
        self.assertEqual(run['stopReason'],'passed')


if __name__=='__main__':unittest.main()
