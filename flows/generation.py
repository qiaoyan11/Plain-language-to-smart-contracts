"""Bounded generation/validation/repair graph. Only trusted tools issue reports."""
import copy
import time
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from langsmith import tracing_context
from agent2.model import call_model, ModelError, ALLOWED_MODELS
from agent2.prompts import build_messages, build_repair_messages, PROMPT_VERSION, REPAIR_PROMPT_VERSION
from agent2.compiler import compile_bundle
from shared.handoff import ROOT, validate, validate_request, validate_response, source_hash

MAX_REPAIRS = 5  # operational ceiling, not the formal experiment budget


class State(TypedDict, total=False):
    request: dict
    result: dict
    modelOutput: dict
    prompts: dict
    compilation: dict | None
    error: str | None
    feedback: list
    history: list
    modelCalls: list
    stopReason: str | None


def envelope(request, result):
    return {'interfaceVersion': 1, 'requestId': request['requestId'], 'status': 'ok', 'result': result, 'errors': []}


def empty_result(status):
    return {'status': status, 'sourceBundle': None, 'validationReport': None, 'attempts': []}


def trusted_validate(spec, bundle):
    from validation import validate_development
    return validate_development(spec, bundle)


def allowed_feedback(report, setting):
    """Never send the whole report, artifact or excluded check status to the model."""
    names = {'compilation', 'staticAnalysis'} if setting == 'B' else {'compilation', 'staticAnalysis', 'clauseTests'} if setting == 'C' else set()
    return [copy.deepcopy(check) for check in report['checks']
            if check['name'] in names and check['status'] == 'failed']


def build_graph(model_call=call_model, compiler=compile_bundle, validator=trusted_validate,
                initial_bundle=None, on_record=None):
    def record(item):
        if on_record:
            on_record(copy.deepcopy(item))

    def check_input(state):
        request = state['request']
        validate_request(request)
        if request['operation'] != 'generate':
            raise ValueError('Agent 2 requires generate operation')
        config = request['payload']['runConfig']
        if config['maxRepairs'] > MAX_REPAIRS:
            raise ValueError('Operational ceiling is 5 repairs; choose an explicit smaller budget.')
        if config['feedbackSetting'] in ('A', 'baseline') and config['maxRepairs'] != 0:
            raise ValueError('A/baseline cannot repair.')
        if config['validationMode'] == 'none' and (config['maxRepairs'] != 0 or config['feedbackSetting'] not in ('A', 'baseline')):
            raise ValueError('Compilation smoke mode requires A/baseline and maxRepairs=0.')
        if config['model'] not in ALLOWED_MODELS:
            raise ValueError('Select the supported GPT-5.4 mini model explicitly for a live run.')
        system, user = build_messages(request['payload']['spec'])
        result = empty_result('toolError')
        if initial_bundle is not None:
            if config['validationMode'] != 'development':
                raise ValueError('Resuming source requires fresh development validation.')
            validate('SourceBundle', initial_bundle)
            if initial_bundle['sources'].get('IMilestoneEscrow.sol') != (ROOT / 'contracts/IMilestoneEscrow.sol').read_text():
                raise ValueError('Resumed source must retain the frozen interface.')
            result = {'status': 'generated', 'sourceBundle': copy.deepcopy(initial_bundle), 'validationReport': None,
                      'attempts': [{'attempt': 0, 'sourceHash': initial_bundle['sourceHash'], 'reportId': None, 'feedbackUsed': []}]}
            validate_response(request, envelope(request, result))
        return {'prompts': {'version': PROMPT_VERSION, 'system': system, 'user': user},
                'compilation': None, 'error': None, 'result': result,
                'history': [], 'modelCalls': [], 'feedback': [], 'stopReason': None}

    def generate(state):
        prompts = state['prompts']
        call = {'call': len(state['modelCalls']), 'attempt': len(state['result']['attempts']),
                'prompts': copy.deepcopy(prompts), 'metadata': {}, 'error': None}
        try:
            output = model_call(prompts['system'], prompts['user'], state['request']['payload']['runConfig']['model'])
        except ModelError as error:
            output = {'source': None, 'metadata': {}, 'error': str(error)}
            status = 'toolError'
        else:
            status = 'failed' if output['error'] else None
        call.update(metadata=output['metadata'], error=output['error'], source=output['source'])
        record({'kind': 'modelCall', **call})
        updates = {'modelOutput': output, 'modelCalls': state['modelCalls'] + [call]}
        if status:
            result = copy.deepcopy(state['result'])
            result['status'] = status
            updates.update(error=output['error'], result=result, stopReason='model_error')
        return updates

    def package(state):
        spec = state['request']['payload']['spec']
        bundle = {'projectId': spec['projectId'], 'specVersion': spec['specVersion'],
                  'sources': {'GeneratedMilestoneEscrow.sol': state['modelOutput']['source'],
                              'IMilestoneEscrow.sol': (ROOT / 'contracts/IMilestoneEscrow.sol').read_text()},
                  'entryFile': 'GeneratedMilestoneEscrow.sol', 'entryContract': 'GeneratedMilestoneEscrow',
                  'compilerVersion': '0.8.28', 'buildSettings': {'evmVersion': 'paris', 'optimizer': {'enabled': True, 'runs': 200}},
                  'dependencies': []}
        bundle['sourceHash'] = source_hash(bundle)
        attempts = copy.deepcopy(state['result']['attempts'])
        attempts.append({'attempt': len(attempts), 'sourceHash': bundle['sourceHash'], 'reportId': None,
                         'feedbackUsed': [c['name'] + ':' + f['code'] for c in state['feedback'] for f in c['findings']]})
        result = {'status': 'generated', 'sourceBundle': bundle, 'validationReport': None, 'attempts': attempts}
        validate_response(state['request'], envelope(state['request'], result))
        return {'result': result}

    def check_source(state):
        result = copy.deepcopy(state['result'])
        request = state['request']
        report = None
        error = None
        # Save source before tools run, so an interrupted validator cannot erase a paid output.
        record({'kind': 'source', 'attempt': result['attempts'][-1]['attempt'], 'sourceBundle': result['sourceBundle']})
        if request['payload']['runConfig']['validationMode'] == 'none':
            compilation = compiler(request, envelope(request, result))
            if compilation['status'] != 'passed':
                result['status'] = 'toolError' if compilation['status'] == 'toolError' else 'failed'
        else:
            try:
                report = validator(copy.deepcopy(request['payload']['spec']), copy.deepcopy(result['sourceBundle']))
                result['validationReport'] = report
                result['attempts'][-1]['reportId'] = report['reportId']
                # A mixed report (code failure + tool failure) must also stop repairs.
                tool_error = report['status'] == 'toolError' or any(c['status'] == 'toolError' for c in report['checks'])
                result['status'] = 'toolError' if tool_error else 'validated' if report['status'] == 'passed' else 'failed'
                validate_response(request, envelope(request, result))
                compilation = copy.deepcopy(next(c for c in report['checks'] if c['name'] == 'compilation'))
            except Exception:
                # Invalid reports/import errors are infrastructure failures, not model feedback.
                result['status'] = 'toolError'
                result['validationReport'] = None
                result['attempts'][-1]['reportId'] = None
                report, compilation = None, None
                error = 'VALIDATOR_TOOL_ERROR: validator unavailable, raised an exception, or returned an invalid report.'
        item = {'attempt': result['attempts'][-1]['attempt'], 'sourceBundle': copy.deepcopy(result['sourceBundle']),
                'validationReport': report, 'compilation': compilation, 'status': result['status'], 'error': error}
        record({'kind': 'validation', **item})
        return {'result': result, 'compilation': compilation, 'error': error, 'history': state['history'] + [item]}

    def decide(state):
        result = state['result']
        config = state['request']['payload']['runConfig']
        if result['status'] == 'toolError':
            reason = 'tool_error'
        elif result['status'] in ('validated', 'generated'):
            reason = 'passed' if result['status'] == 'validated' else 'smoke_complete'
        elif config['feedbackSetting'] in ('A', 'baseline') or config['maxRepairs'] == 0:
            reason = 'no_repairs'
        elif len(result['attempts']) >= config['maxRepairs'] + 1:
            reason = 'repair_budget_exhausted'
        else:
            feedback = allowed_feedback(result['validationReport'], config['feedbackSetting'])
            if feedback:
                return {'feedback': feedback, 'stopReason': None}
            reason = 'no_eligible_feedback'
        return {'feedback': [], 'stopReason': reason}

    def prepare_repair(state):
        system, user = build_repair_messages(state['request']['payload']['spec'],
                                            state['result']['sourceBundle'], state['feedback'])
        return {'prompts': {'version': REPAIR_PROMPT_VERSION, 'system': system, 'user': user}}

    graph = StateGraph(State)
    for name, fn in [('check_input', check_input), ('generate_source', generate), ('package_source', package),
                     ('check_source', check_source), ('decide', decide), ('prepare_repair', prepare_repair)]:
        graph.add_node(name, fn)
    graph.add_edge(START, 'check_input')
    graph.add_conditional_edges('check_input', lambda s: 'check_source' if initial_bundle is not None else 'generate_source')
    graph.add_conditional_edges('generate_source', lambda s: END if s['error'] else 'package_source')
    graph.add_edge('package_source', 'check_source')
    graph.add_edge('check_source', 'decide')
    graph.add_conditional_edges('decide', lambda s: END if s['stopReason'] else 'prepare_repair')
    graph.add_edge('prepare_repair', 'generate_source')
    return graph.compile()


def run_generation(request, *, model_call=call_model, compiler=compile_bundle, validator=trusted_validate,
                   initial_bundle=None, on_record=None):
    start = time.monotonic()
    with tracing_context(enabled=False):
        state = build_graph(model_call, compiler, validator, initial_bundle, on_record).invoke(
            {'request': copy.deepcopy(request)}, {'recursion_limit': 8 + 6 * MAX_REPAIRS})
    response = envelope(request, state['result'])
    validate_response(request, response)
    calls = state['modelCalls']
    usage = {key: sum((c['metadata'].get('usage') or {}).get(key, 0) or 0 for c in calls)
             for key in ('input_tokens', 'output_tokens', 'total_tokens')}
    metadata = copy.deepcopy(calls[-1]['metadata']) if calls else {}
    metadata.update(apiCalls=sum(c['metadata'].get('apiCalls', 0) for c in calls), usage=usage,
                    callAttempts=len(calls))
    return {'response': response, 'compilation': state['compilation'], 'error': state['error'],
            'metadata': metadata, 'prompts': state['prompts'], 'modelCalls': calls, 'history': state['history'],
            'resumedSource': initial_bundle is not None, 'stopReason': state['stopReason'],
            'elapsedSeconds': round(time.monotonic() - start, 3)}
