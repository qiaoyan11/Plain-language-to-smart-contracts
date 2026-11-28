"""Interactive live drafting. Keep the previous terms and questions across turns."""
import json
import sys

from agent1.service import draft_agreement
from agent1.template import render


def run():
    history, draft = [], None
    print("Describe the agreement. Use /end on its own line to submit each turn, /quit to exit.")
    while True:
        lines = []
        for raw in sys.stdin:
            line = raw.rstrip('\n')
            if line == '/quit':
                return
            if line == '/end':
                break
            lines.append(line)
        if not lines:
            return
        message = '\n'.join(lines)
        result, notes = draft_agreement(dict(message=message, history=history, draftSpec=draft))
        print(render(result, notes), flush=True)
        draft = result['draftSpec']
        history.extend([dict(role='user', content=message),
                        dict(role='assistant', content=json.dumps(dict(result=result, separateTerms=notes), ensure_ascii=False))])


if __name__ == '__main__':
    run()
