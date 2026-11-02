"""No language model, signing, or chain operations."""
from shared.handoff import validate


def plan_action(payload):
    validate('PlanInput', payload)
    return validate('PlanResult', {'status': 'blocked', 'question': None, 'intent': None,
                                  'summary': 'STUB: operation planning is not connected; no transaction was sent.'})
