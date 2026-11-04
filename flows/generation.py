"""Single-generation LangGraph. Independent validation/repair is deliberately absent."""
import copy
import time
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from langsmith import tracing_context
from agent2.model import call_model, ModelError, ALLOWED_MODELS
from agent2.prompts import build_messages, PROMPT_VERSION
from agent2.compiler import compile_bundle
from shared.handoff import ROOT, validate_request, validate_response, source_hash


class State(TypedDict, total=False):
    request: dict
    result: dict
    modelOutput: dict
    prompts: dict
    compilation: dict | None
    error: str | None


def envelope(request, result):
    return {'interfaceVersion': 1, 'requestId': request['requestId'], 'status': 'ok', 'result': result, 'errors': []}


def empty_result(status):
    return {'status': status, 'sourceBundle': None, 'validationReport': None, 'attempts': []}


def build_graph(model_call=call_model, compiler=compile_bundle):
    def check_input(state):
        request = state['request']
        validate_request(request)
        if request['operation'] != 'generate':
            raise ValueError('Agent 2 requires generate operation')
        config = request['payload']['runConfig']
        if config['validationMode'] != 'none' or config['maxRepairs'] != 0 or config['feedbackSetting'] not in ('A', 'baseline'):
            raise ValueError('This milestone supports only single generation (A/baseline, maxRepairs=0, validationMode=none). Independent validation and B/C are not connected.')
        if config['model'] not in ALLOWED_MODELS:
            raise ValueError('Select the supported GPT-5.4 mini model explicitly for a live run.')
        system, user = build_messages(request['payload']['spec'])
        return {'prompts': {'version': PROMPT_VERSION, 'system': system, 'user': user},
                'compilation': None, 'error': None, 'result': empty_result('toolError')}

    def generate(state):
        try:
            output = model_call(state['prompts']['system'], state['prompts']['user'], state['request']['payload']['runConfig']['model'])
        except ModelError as error:
            return {'error': str(error), 'result': empty_result('toolError')}
        if output['error']:
            return {'modelOutput': output, 'error': output['error'], 'result': empty_result('failed')}
        return {'modelOutput': output}

    def package(state):
        if state['error']:
            return {}
        spec = state['request']['payload']['spec']
        bundle = {'projectId': spec['projectId'], 'specVersion': spec['specVersion'],
                  'sources': {'GeneratedMilestoneEscrow.sol': state['modelOutput']['source'],
                              'IMilestoneEscrow.sol': (ROOT / 'contracts/IMilestoneEscrow.sol').read_text()},
                  'entryFile': 'GeneratedMilestoneEscrow.sol', 'entryContract': 'GeneratedMilestoneEscrow',
                  'compilerVersion': '0.8.28', 'buildSettings': {'evmVersion': 'paris', 'optimizer': {'enabled': True, 'runs': 200}},
                  'dependencies': []}
        bundle['sourceHash'] = source_hash(bundle)
        result = {'status': 'generated', 'sourceBundle': bundle, 'validationReport': None,
                  'attempts': [{'attempt': 0, 'sourceHash': bundle['sourceHash'], 'reportId': None, 'feedbackUsed': []}]}
        validate_response(state['request'], envelope(state['request'], result))
        return {'result': result}

    def compile_source(state):
        if state['error']:
            return {}
        report = compiler(state['request'], envelope(state['request'], state['result']))
        result = copy.deepcopy(state['result'])
        if report['status'] != 'passed':
            result['status'] = 'toolError' if report['status'] == 'toolError' else 'failed'
        # Even passed compilation leaves status=generated, report=null. No deployment authority.
        return {'compilation': report, 'result': result}

    graph = StateGraph(State)
    for name, fn in [('check_input', check_input), ('generate_source', generate), ('package_source', package), ('compile_source', compile_source)]:
        graph.add_node(name, fn)
    graph.add_edge(START, 'check_input')
    graph.add_edge('check_input', 'generate_source')
    graph.add_edge('generate_source', 'package_source')
    graph.add_edge('package_source', 'compile_source')
    graph.add_edge('compile_source', END)
    return graph.compile()


def run_generation(request, *, model_call=call_model, compiler=compile_bundle):
    start = time.monotonic()
    # Keep prompts/results local; no implicit external tracing via environment settings.
    with tracing_context(enabled=False):
        state = build_graph(model_call, compiler).invoke({'request': copy.deepcopy(request)}, {'recursion_limit': 8})
    response = envelope(request, state['result'])
    validate_response(request, response)
    return {'response': response, 'compilation': state['compilation'], 'error': state['error'],
            'metadata': state.get('modelOutput', {}).get('metadata', {}), 'prompts': state['prompts'],
            'elapsedSeconds': round(time.monotonic() - start, 3)}
