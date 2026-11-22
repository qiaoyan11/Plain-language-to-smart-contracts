"""Default stub for Agent 3; AGENT3_MODE=live switches to the model-backed service."""
import os
from shared.handoff import validate


def plan_action(payload):
    mode = os.getenv('AGENT3_MODE', 'stub')
    if mode == 'live':
        from agent3.service import plan_action as live
        return live(payload)
    if mode != 'stub':
        raise ValueError('AGENT3_MODE must be stub or live')
    validate('PlanInput', payload)
    return validate('PlanResult', {'status': 'blocked', 'question': None, 'intent': None,
                                  'summary': 'STUB: operation planning is not connected; no transaction was sent.'})
