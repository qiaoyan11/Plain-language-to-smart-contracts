"""Run a clarify envelope or render a drafting worksheet."""
import argparse
import json
import os
from pathlib import Path

from agent1.template import render
from flows.worker import dispatch

parser = argparse.ArgumentParser()
parser.add_argument('request', type=Path)
parser.add_argument('--template', action='store_true', help='print the human-readable worksheet')
args = parser.parse_args()
request = json.loads(args.request.read_text())
if request.get('operation') != 'clarify':
    parser.error('expected a clarify envelope')
if args.template and os.getenv('AGENT1_MODE') == 'live':
    from agent1.service import draft_agreement
    from shared.handoff import validate_request
    validate_request(request)
    print(render(*draft_agreement(request['payload'])))
else:
    response = dispatch(request)
    print(render(response['result']) if args.template else json.dumps(response, ensure_ascii=False))
