"""Fixture-only replacement point; never claims to understand arbitrary prose."""
import os
import copy
import json
from shared.handoff import ROOT, validate


def clarify(payload):
    mode = os.getenv('AGENT1_MODE', 'stub')
    if mode == 'live':
        from agent1.service import clarify as live
        return live(payload)
    if mode != 'stub':
        raise ValueError('AGENT1_MODE must be stub or live')
    validate('ClarifyInput', payload)
    draft = copy.deepcopy(payload['draftSpec']) if payload['draftSpec'] is not None else json.loads((ROOT / 'shared/examples/agreement.draft.json').read_text())
    result = {'status': 'needsClarification', 'draftSpec': draft,
              'questions': [{'field': 'message', 'question': 'STUB: no language model is connected. Review the fixture rules manually.'}],
              'unsupportedTerms': []}
    return validate('ClarifyResult', result)
