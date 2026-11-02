"""Fixture-only replacement point; never claims to understand arbitrary prose."""
import copy
import json
from shared.handoff import ROOT, validate


def clarify(payload):
    validate('ClarifyInput', payload)
    draft = copy.deepcopy(payload['draftSpec']) if payload['draftSpec'] is not None else json.loads((ROOT / 'shared/examples/agreement.draft.json').read_text())
    result = {'status': 'needsClarification', 'draftSpec': draft,
              'questions': [{'field': 'message', 'question': 'STUB: no language model is connected. Review the fixture rules manually.'}],
              'unsupportedTerms': []}
    return validate('ClarifyResult', result)
