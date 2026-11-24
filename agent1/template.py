"""Human-readable worksheet rendered from the same validated handoff as Agent 2."""
from shared.handoff import validate


def render(result, separate_terms=()):
    validate('ClarifyResult', result)
    draft = result['draftSpec']
    lines = [f"Agreement draft — {draft['name']}", f"Review status: {result['status']}",
             f"Client wallet: {draft['clientWallet'] or '[missing]'}",
             f"Provider wallet: {draft['developerWallet'] or '[missing]'}",
             f"Total deposit (wei): {draft['totalAmountWei'] or '[unresolved]'}",
             "Payment schedule (in order):"]
    for row in draft['milestones']:
        lines.append(f"  {row['id']}. {row['title']} — {row['amountWei'] or '[unresolved]'} wei")
    if not draft['milestones']:
        lines.append("  [Schedule needs clarification]")
    lines.extend(["Release: the client accepts each milestone to pay the provider.",
                  "If approval stalls, the current contract has no timeout, refund or dispute settlement."])
    if separate_terms:
        lines.append("Separate written terms to review (outside the generated contract):")
        lines.extend('  - ' + term for term in separate_terms)
    if result['unsupportedTerms']:
        lines.append("Requested terms outside this contract:")
        lines.extend('  - ' + term for term in result['unsupportedTerms'])
    if result['questions']:
        lines.append("Questions for the parties:")
        lines.extend('  - ' + q['question'] for q in result['questions'])
    return '\n'.join(lines)
