"""Run an envelope fixture from the repository root."""
import json
import sys
from pathlib import Path
from flows.worker import dispatch

if len(sys.argv) != 2:
    raise SystemExit("Usage: python -m agent3 <request.json>")
request = json.loads(Path(sys.argv[1]).read_text())
if request.get('operation') != 'planAction':
    raise SystemExit('Wrong operation for agent3')
print(json.dumps(dispatch(request), ensure_ascii=False))
