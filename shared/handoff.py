"""Shared wire validation; no agents or chain execution belong here."""
import hashlib
import json
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / 'shared/schemas/handoff.schema.json').read_text())
OPS = {'clarify': 'Clarify', 'generate': 'Generate', 'planAction': 'Plan'}
MAX_UINT = 2**256 - 1


def source_hash(bundle):
    keys = ('sources', 'entryFile', 'entryContract', 'compilerVersion', 'buildSettings', 'dependencies')
    raw = json.dumps({k: bundle[k] for k in keys}, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return 'sha256:' + hashlib.sha256(raw.encode('utf-8')).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate(kind, data):
    schema = {**SCHEMA, '$ref': '#/$defs/' + kind}
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(data)
    if kind in ('ConfirmedSpec', 'DraftSpec'):
        addresses = [data[k].lower() for k in ('clientWallet', 'developerWallet') if data[k] is not None]
        require('0x' + '0'*40 not in addresses, 'Zero address is invalid')
        require(len(set(addresses)) == len(addresses), 'Client and provider must differ')
        require([m['id'] for m in data['milestones']] == list(range(1, len(data['milestones']) + 1)), 'Milestones must be consecutive')
        amounts = [int(m['amountWei']) for m in data['milestones'] if m['amountWei'] is not None]
        require(all(0 < n <= MAX_UINT for n in amounts) and sum(amounts) <= MAX_UINT, 'Amount exceeds uint256')
        total = data['totalAmountWei']
        if total is not None:
            require(0 < int(total) <= MAX_UINT, 'Invalid total')
            if len(amounts) == len(data['milestones']) and amounts:
                require(int(total) == sum(amounts), 'Total does not equal milestone sum')
    elif kind == 'SourceBundle':
        require(data['entryFile'] in data['sources'], 'Entry file missing')
        require(source_hash(data) == data['sourceHash'], 'Source hash mismatch')
    elif kind == 'GenerateInput':
        validate('ConfirmedSpec', data['spec'])
        for key in ('projectId', 'specVersion'):
            require(data['confirmation'][key] == data['spec'][key], 'Confirmation version mismatch')
    elif kind == 'ClarifyInput' and data['draftSpec'] is not None:
        validate('DraftSpec', data['draftSpec'])
    elif kind == 'ClarifyResult':
        validate('DraftSpec', data['draftSpec'])
        if data['status'] == 'readyForConfirmation':
            validate('ConfirmedSpec', data['draftSpec'])
            require(not data['questions'] and not data['unsupportedTerms'], 'Unresolved terms cannot be ready')
    elif kind == 'ValidationReport':
        require({c['name'] for c in data['checks']} == {'compilation', 'staticAnalysis', 'clauseTests'}, 'Missing or duplicate checks')
        if data['status'] == 'passed':
            require(all(c['status'] == 'passed' for c in data['checks']), 'Skipped or failed check cannot pass')
            require(data['artifact'] is not None, 'Passed report needs artifact')
            require(data['artifact']['sourceHash'] == data['sourceHash'], 'Artifact hash mismatch')
        else:
            require(data['artifact'] is None, 'Non-passed report cannot have artifact')
    elif kind == 'GenerateResult':
        bundle, report = data['sourceBundle'], data['validationReport']
        if bundle is not None:
            validate('SourceBundle', bundle)
        if report is not None:
            validate('ValidationReport', report)
            require(bundle is not None, 'Report needs bundle')
            for key in ('projectId', 'specVersion', 'sourceHash'):
                require(report[key] == bundle[key], 'Report does not match source')
            if report['artifact'] is not None:
                for key in ('compilerVersion', 'buildSettings'):
                    require(report['artifact'][key] == bundle[key], 'Artifact build settings mismatch')
        if data['status'] == 'validated':
            require(report is not None and report['status'] == 'passed', 'Validated needs passed report')
        if data['status'] == 'generated':
            require(bundle is not None and report is None, 'Generated must have unvalidated source')
        require([a['attempt'] for a in data['attempts']] == list(range(len(data['attempts']))), 'Attempt order invalid')
        if bundle is not None:
            require(bool(data['attempts']) and data['attempts'][-1]['sourceHash'] == bundle['sourceHash'], 'Last attempt hash mismatch')
            require(data['attempts'][-1]['reportId'] == (report['reportId'] if report else None), 'Last attempt report mismatch')
    elif kind == 'PlanInput':
        require(data['snapshot']['id'] == data['projectId'], 'Snapshot project mismatch')
        require(data['snapshot']['contractAddress'] is not None and
                data['snapshot']['contractAddress'].lower() == data['deployment']['contractAddress'].lower(), 'Deployment address mismatch')
    elif kind == 'PlanResult':
        intent = data['intent']
        require((intent is not None) == (data['status'] == 'readyForConfirmation'), 'Intent status mismatch')
        if intent:
            require((intent['milestoneId'] is not None) == (intent['action'] == 'acceptMilestone'), 'Invalid milestone argument')
    return data


def validate_request(request):
    validate('Request', request)
    validate(OPS[request['operation']] + 'Input', request['payload'])


def validate_response(request, response):
    validate('Response', response)
    require(response['requestId'] == request['requestId'], 'Response requestId mismatch')
    if response['status'] == 'error':
        require(response['result'] is None and bool(response['errors']), 'Invalid error envelope')
        return
    require(not response['errors'], 'Successful envelope cannot contain errors')
    validate(OPS[request['operation']] + 'Result', response['result'])
    if request['operation'] == 'generate':
        require(len(response['result']['attempts']) <= request['payload']['runConfig']['maxRepairs'] + 1, 'Repair budget exceeded')
        bundle = response['result']['sourceBundle']
        if bundle:
            for key in ('projectId', 'specVersion'):
                require(bundle[key] == request['payload']['spec'][key], 'Stale generation result')
        if request['payload']['runConfig']['validationMode'] == 'none':
            require(response['result']['validationReport'] is None and response['result']['status'] != 'validated', 'Validation was disabled')
    if request['operation'] == 'planAction' and response['result']['intent'] is not None:
        intent = response['result']['intent']
        require(intent['projectId'] == request['payload']['projectId'], 'Intent project mismatch')
        deployment = request['payload']['deployment']
        require(intent['chainId'] == deployment['chainId'] and
                intent['contractAddress'].lower() == deployment['contractAddress'].lower(), 'Intent deployment mismatch')
