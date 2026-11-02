"""Returns the existing reference code for wiring tests, not AI generation."""
from shared.handoff import ROOT, source_hash, validate


def generate(payload):
    validate('GenerateInput', payload)
    config = payload['runConfig']
    if config['feedbackSetting'] != 'baseline' or config['maxRepairs'] != 0:
        raise ValueError('Stub supports baseline and maxRepairs=0 only; no experiment is implemented')
    spec = payload['spec']
    bundle = {'projectId': spec['projectId'], 'specVersion': spec['specVersion'],
              'sources': {name: (ROOT / 'contracts' / name).read_text() for name in ('MilestoneEscrow.sol', 'IMilestoneEscrow.sol')},
              'entryFile': 'MilestoneEscrow.sol', 'entryContract': 'MilestoneEscrow', 'compilerVersion': '0.8.28',
              'buildSettings': {'evmVersion': 'paris', 'optimizer': {'enabled': True, 'runs': 200}}, 'dependencies': []}
    bundle['sourceHash'] = source_hash(bundle)
    result = {'status': 'generated', 'sourceBundle': bundle, 'validationReport': None,
              'attempts': [{'attempt': 0, 'sourceHash': bundle['sourceHash'], 'reportId': None, 'feedbackUsed': []}]}
    if config['validationMode'] == 'development':
        # No fabricated validation report. Claude owns the validator and its stub.
        result['status'] = 'toolError'
    return validate('GenerateResult', result)
