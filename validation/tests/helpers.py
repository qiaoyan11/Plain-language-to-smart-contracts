"""Shared helpers for validator self-tests: build SourceBundles from the known-good fixture."""
import copy
import json
from pathlib import Path
from shared.handoff import ROOT, source_hash

FIXTURE = Path(__file__).resolve().parent / 'fixtures/KnownGoodEscrow.sol'
GOOD = FIXTURE.read_text()
INTERFACE = (ROOT / 'contracts/IMilestoneEscrow.sol').read_text()
SPEC = json.loads((ROOT / 'agent2/examples/generate.request.json').read_text())['payload']['spec']


def bundle(source=GOOD, interface=INTERFACE, contract='KnownGoodEscrow', rehash=True):
    b = {'projectId': SPEC['projectId'], 'specVersion': SPEC['specVersion'],
         'sources': {'KnownGoodEscrow.sol': source, 'IMilestoneEscrow.sol': interface},
         'entryFile': 'KnownGoodEscrow.sol', 'entryContract': contract, 'compilerVersion': '0.8.28',
         'buildSettings': {'evmVersion': 'paris', 'optimizer': {'enabled': True, 'runs': 200}},
         'dependencies': [], 'sourceHash': 'sha256:' + '0' * 64}
    if rehash:
        b['sourceHash'] = source_hash(b)
    return b


def mutate(old, new, source=GOOD):
    assert source.count(old) == 1, f'mutation anchor must occur exactly once: {old!r}'
    return source.replace(old, new)


def spec():
    return copy.deepcopy(SPEC)
