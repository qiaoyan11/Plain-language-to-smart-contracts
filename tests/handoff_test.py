import copy
import json
import unittest
import subprocess
import sys
from shared.handoff import ROOT, SCHEMA, validate, validate_response, source_hash
from jsonschema import Draft202012Validator
from flows.worker import dispatch

REQUEST = json.loads((ROOT / 'shared/examples/generate.request.json').read_text())

class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.request = copy.deepcopy(REQUEST)
        self.spec = self.request['payload']['spec']

    def test_schema_is_valid(self):
        Draft202012Validator.check_schema(SCHEMA)

    def test_all_examples(self):
        for filename, kind in [('confirmed-spec.json','ConfirmedSpec'), ('agreement.draft.json','DraftSpec'), ('source-bundle.json','SourceBundle'), ('validation-report.json','ValidationReport'), ('deployment-record.json','DeploymentRecord')]:
            validate(kind, json.loads((ROOT/'shared/examples'/filename).read_text()))

    def test_generate_is_not_validated(self):
        response = dispatch(self.request)
        self.assertEqual(response['result']['status'], 'generated')
        self.assertIsNone(response['result']['validationReport'])
        validate_response(self.request, response)

    def test_no_validator_never_passes(self):
        self.request['payload']['runConfig']['validationMode'] = 'development'
        self.assertEqual(dispatch(self.request)['result']['status'], 'toolError')

    def test_confirmation_mismatch(self):
        self.request['payload']['confirmation']['specVersion'] = 2
        with self.assertRaises(ValueError): dispatch(self.request)

    def test_bad_business_terms(self):
        for key, value in [('clientWallet','0x'+'0'*40), ('developerWallet',self.spec['clientWallet']), ('totalAmountWei','1')]:
            with self.subTest(key=key):
                bad = copy.deepcopy(self.spec); bad[key] = value
                with self.assertRaises(ValueError): validate('ConfirmedSpec',bad)
        self.spec['milestones'][0]['id'] = 2
        with self.assertRaises(ValueError): validate('ConfirmedSpec',self.spec)

    def test_count_and_amount_rejections(self):
        for amount in [0, '0', '-1', '1.2', '01', str(2**256)]:
            with self.subTest(amount=amount):
                bad=copy.deepcopy(self.spec); bad['milestones'][0]['amountWei']=amount
                with self.assertRaises(Exception): validate('ConfirmedSpec',bad)
        for count in [0,6]:
            bad=copy.deepcopy(self.spec); bad['milestones']=[bad['milestones'][0]]*count
            with self.assertRaises(Exception): validate('ConfirmedSpec',bad)

    def test_unknown_fields_and_operations(self):
        self.spec['executeNow']=True
        with self.assertRaises(Exception): dispatch(self.request)
        self.request=copy.deepcopy(REQUEST); self.request['operation']='send'
        with self.assertRaises(Exception): dispatch(self.request)

    def test_source_hash_and_path(self):
        bundle=dispatch(self.request)['result']['sourceBundle']
        bundle['sources']['MilestoneEscrow.sol'] += '\n// modified'
        with self.assertRaises(ValueError): validate('SourceBundle',bundle)
        bundle['sources']['../escape.sol']='code'; bundle['sourceHash']=source_hash(bundle)
        with self.assertRaises(Exception): validate('SourceBundle',bundle)

    def test_hash_is_order_independent(self):
        bundle=dispatch(self.request)['result']['sourceBundle']
        original=source_hash(bundle)
        bundle['sources']=dict(reversed(list(bundle['sources'].items())))
        self.assertEqual(original,source_hash(bundle))

    def test_fake_pass_rejected(self):
        report=json.loads((ROOT/'shared/examples/validation-report.json').read_text())
        report['status']='passed'
        with self.assertRaises(ValueError): validate('ValidationReport',report)
        response=dispatch(self.request); response['result']['status']='validated'
        with self.assertRaises(ValueError): validate_response(self.request,response)

    def test_stale_response_rejected(self):
        response=dispatch(self.request); response['result']['sourceBundle']['specVersion']=2
        with self.assertRaises(ValueError): validate_response(self.request,response)

    def test_no_invented_experiment(self):
        self.request['payload']['runConfig']['feedbackSetting']='A'
        with self.assertRaises(ValueError): dispatch(self.request)

    def test_worker_invalid_json_returns_error_envelope(self):
        result = subprocess.run([sys.executable, '-m', 'flows.worker'], input='{broken',
                                text=True, capture_output=True, cwd=ROOT, timeout=10)
        response = json.loads(result.stdout)
        self.assertEqual(response['status'], 'error')
        self.assertIsNone(response['result'])

    def test_plan_cannot_redirect_to_other_contract(self):
        request=json.loads((ROOT/'shared/examples/planAction.request.json').read_text())
        request['payload']['snapshot']['contractAddress']='0x'+'2'*40
        with self.assertRaises(ValueError): dispatch(request)

    def test_clarify_cannot_confirm_and_plan_cannot_send(self):
        for op, expected in [('clarify','needsClarification'),('planAction','blocked')]:
            request=json.loads((ROOT/'shared/examples'/f'{op}.request.json').read_text())
            self.assertEqual(dispatch(request)['result']['status'],expected)

if __name__ == '__main__': unittest.main()
