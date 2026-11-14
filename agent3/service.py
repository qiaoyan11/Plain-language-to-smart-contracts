"""Plan an escrow action: validate, call the model, then let the rules decide."""
import sys
from shared.handoff import validate
from agent3.model import ModelError, call_model
from agent3.prompts import SYSTEM, build_user
from agent3.rules import clarify, decide, guess_language, refusal

MAX_MESSAGE_CHARS = 2000


def plan_action(payload, call=None):
    call = call or call_model
    validate('PlanInput', payload)
    message = payload['message']
    language = guess_language(message)
    if not message.strip():
        return validate('PlanResult', clarify(language))
    if len(message) > MAX_MESSAGE_CHARS:
        return validate('PlanResult', refusal('too_long', language))
    try:
        parsed, _ = call(SYSTEM, build_user(message, payload['snapshot']))
    except ModelError as error:
        print(str(error), file=sys.stderr)
        return validate('PlanResult', refusal('model_error', language))
    except Exception as error:
        print(type(error).__name__, file=sys.stderr)
        return validate('PlanResult', refusal('model_error', language))
    return validate('PlanResult', decide(parsed, payload))
