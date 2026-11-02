"""Run an envelope fixture from the repository root."""
import json
import sys
from pathlib import Path
from flows.worker import dispatch

if len(sys.argv) != 2:
    raise SystemExit("Usage: python -m agent2 <request.json>")
request = json.loads(Path(sys.argv[1]).read_text())
if request.get('operation') != 'generate':
    raise SystemExit('Wrong operation for agent2')
print(json.dumps(dispatch(request), ensure_ascii=False))
