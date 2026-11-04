"""Mutation tests: each typical defect must make the independent clause tests fail.

Static analysis is switched off here (test-only switch, the report can then never pass) so the
assertions prove the clause tests themselves catch the defect, not Slither.
"""
import unittest
from validation import validate_development_detailed
from validation.tests.helpers import bundle, mutate, spec

ACCEPT = 'function acceptMilestone(uint256 id) external override {\n        if (msg.sender != client) revert Rejected();'
DEPOSIT = 'function deposit() external payable override {\n        if (msg.sender != client) revert Rejected();'

MUTANTS = {
    # name: (old, new, clause ids that must fail)
    'accept-without-client-check': (ACCEPT, 'function acceptMilestone(uint256 id) external override {', {'access-accept'}),
    'deposit-without-client-check': (DEPOSIT, 'function deposit() external payable override {', {'access-deposit'}),
    'skip-ahead-allowed': ('if (id != nextMilestone) revert Rejected();', 'if (paid[id]) revert Rejected();', {'order-skip'}),
    'repeat-payment-allowed': ('if (id != nextMilestone) revert Rejected();', 'if (id > nextMilestone) revert Rejected();', {'order-repeat'}),
    'no-funded-check': ('if (!funded) revert Rejected();', '', {'unfunded-forced-eth'}),
    'overpayment-accepted': ('if (msg.value != totalAmount)', 'if (msg.value < totalAmount)', {'deposit-exact'}),
    'second-deposit-allowed': ('if (funded) revert Rejected();', '', {'deposit-once'}),
    'transfer-failure-ignored': ('(bool ok, ) = payable(provider).call{value: amount}("");\n        if (!ok) revert Rejected();',
                                 'payable(provider).call{value: amount}("");', {'recipient-reject-rollback'}),
    'pays-first-amount-every-time': ('uint256 amount = amounts[id - 1];', 'uint256 amount = amounts[0];', {'flow-2', 'flow-spec'}),
    'pays-the-client': ('payable(provider).call{value: amount}', 'payable(client).call{value: amount}', {'flow-1', 'flow-spec'}),
    'paid-flag-not-set': ('paid[id] = true;', '', {'flow-1', 'flow-spec'}),
    'wrong-event-recipient': ('emit MilestonePaid(id, provider, amount);', 'emit MilestonePaid(id, client, amount);', {'flow-1'}),
    'six-milestones-allowed': ('amounts_.length > 5', 'amounts_.length > 6', {'constructor-6'}),
    'zero-amount-allowed': ('if (amounts_[i] == 0) revert Rejected();', '', {'constructor-zero-first', 'constructor-zero-later'}),
    'same-parties-allowed': ('if (client_ == provider_) revert Rejected();', '', {'constructor-same-parties'}),
}


class MutantTests(unittest.TestCase):
    def test_known_good_fixture_passes_every_clause(self):
        report, evidence = validate_development_detailed(spec(), bundle(), static_analysis=False)
        clauses = {c['name']: c for c in report['checks']}
        self.assertEqual(clauses['compilation']['status'], 'passed')
        self.assertEqual(clauses['clauseTests']['status'], 'passed', clauses['clauseTests']['findings'])
        self.assertEqual(clauses['staticAnalysis']['status'], 'skipped')
        self.assertEqual(report['status'], 'toolError', 'a skipped check must never yield passed')
        self.assertIsNone(report['artifact'])

    def test_each_mutant_is_caught_by_clause_tests(self):
        for name, (old, new, expected) in MUTANTS.items():
            with self.subTest(mutant=name):
                report, evidence = validate_development_detailed(spec(), bundle(mutate(old, new)), static_analysis=False)
                checks = {c['name']: c['status'] for c in report['checks']}
                self.assertEqual(checks['compilation'], 'passed', 'mutant should still compile')
                self.assertEqual(checks['clauseTests'], 'failed')
                self.assertEqual(report['status'], 'failed')
                self.assertIsNone(report['artifact'])
                failed = {r['id'] for r in evidence['clauseTests']['results'] if r['status'] != 'passed'}
                self.assertTrue(expected <= failed, f'{name}: expected {expected} among failed {failed}')


if __name__ == '__main__':
    unittest.main()
