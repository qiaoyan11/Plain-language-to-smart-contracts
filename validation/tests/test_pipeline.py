"""Full-pipeline tests (compilation + Slither + clause tests) and tool-failure handling."""
import os
import stat
import tempfile
import unittest
from pathlib import Path
from shared.handoff import validate
from validation import SUITE_VERSION, validate_development, validate_development_detailed
from validation.tests.helpers import GOOD, INTERFACE, bundle, mutate, spec


UNCHECKED_OLD = '(bool ok, ) = payable(provider).call{value: amount}("");\n        if (!ok) revert Rejected();'
UNCHECKED_NEW = 'payable(provider).call{value: amount}("");'


def statuses(report):
    return {c['name']: c['status'] for c in report['checks']}


def codes(report, check):
    return {f['code'] for c in report['checks'] if c['name'] == check for f in c['findings']}


class PipelineTests(unittest.TestCase):
    def test_known_good_passes_with_artifact_from_real_tools(self):
        b = bundle()
        report, evidence = validate_development_detailed(spec(), b)
        self.assertEqual(report['status'], 'passed', report['checks'])
        self.assertEqual(set(statuses(report).values()), {'passed'})
        self.assertEqual(report['suiteVersion'], SUITE_VERSION)
        self.assertEqual(report['artifact']['sourceHash'], b['sourceHash'])
        self.assertGreater(len(report['artifact']['bytecode']), 1000)
        self.assertEqual(report['artifact']['bytecode'], evidence['compilation']['entry']['bytecode'])
        self.assertIn('CLAUSE_SUMMARY', codes(report, 'clauseTests'))
        validate('ValidationReport', report)

    def test_unchecked_transfer_is_blocked_by_slither_policy(self):
        report = validate_development(spec(), bundle(mutate(UNCHECKED_OLD, UNCHECKED_NEW)))
        self.assertEqual(statuses(report)['staticAnalysis'], 'failed')
        self.assertIn('SLITHER_unchecked-lowlevel', codes(report, 'staticAnalysis'))
        self.assertEqual(report['status'], 'failed')

    def test_uninitialized_local_is_blocking_medium(self):
        report = validate_development(spec(), bundle(mutate('uint256 sum = 0;', 'uint256 sum;')))
        self.assertEqual(statuses(report), {'compilation': 'passed', 'staticAnalysis': 'failed', 'clauseTests': 'passed'})
        self.assertIn('SLITHER_uninitialized-local', codes(report, 'staticAnalysis'))

    def test_declared_hash_is_recomputed_not_trusted(self):
        b = bundle()
        b['sources']['KnownGoodEscrow.sol'] = b['sources']['KnownGoodEscrow.sol'].replace('> 5', '> 6')
        report = validate_development(spec(), b)
        self.assertEqual(statuses(report), {'compilation': 'failed', 'staticAnalysis': 'skipped', 'clauseTests': 'skipped'})
        self.assertIn('SOURCE_HASH_MISMATCH', codes(report, 'compilation'))
        self.assertEqual(report['status'], 'failed')
        self.assertIsNone(report['artifact'])

    def test_stale_bundle_version_is_rejected(self):
        s = spec(); s['specVersion'] = 2
        report = validate_development(s, bundle())
        self.assertIn('STALE_SOURCE_BUNDLE', codes(report, 'compilation'))
        self.assertEqual(report['status'], 'failed')

    def test_compile_error_skips_later_checks(self):
        report = validate_development(spec(), bundle(GOOD.replace('funded = true;', 'funded = true')))
        self.assertEqual(statuses(report), {'compilation': 'failed', 'staticAnalysis': 'skipped', 'clauseTests': 'skipped'})
        self.assertTrue(any(c.startswith('SOLC_') for c in codes(report, 'compilation')))

    def test_modified_interface_file_fails(self):
        report = validate_development(spec(), bundle(interface=INTERFACE + '\n// edited\n'))
        self.assertIn('INTERFACE_FILE_MODIFIED', codes(report, 'compilation'))
        self.assertEqual(report['status'], 'failed')

    def test_wrong_constructor_fails(self):
        src = GOOD.replace('constructor(address client_, address payable provider_, uint256[] memory amounts_)',
                           'constructor(address client_, address payable provider_, uint256[] memory amounts_, uint256 extra)')
        src = src.replace('        client = client_;', '        extra;\n        client = client_;')
        report = validate_development(spec(), bundle(src))
        self.assertIn('CONSTRUCTOR_MISMATCH', codes(report, 'compilation'))

    def test_missing_slither_is_tool_error_not_zero_findings(self):
        report = validate_development_detailed(spec(), bundle(), slither_path='/nonexistent/slither')[0]
        self.assertEqual(statuses(report)['staticAnalysis'], 'toolError')
        self.assertEqual(statuses(report)['clauseTests'], 'passed')
        self.assertEqual(report['status'], 'toolError')
        self.assertIsNone(report['artifact'])

    def test_unpinned_slither_version_is_tool_error(self):
        with tempfile.TemporaryDirectory() as d:
            fake = Path(d) / 'slither'
            fake.write_text('#!/bin/sh\necho 0.10.0\n')
            fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
            report = validate_development_detailed(spec(), bundle(), slither_path=str(fake))[0]
        self.assertEqual(statuses(report)['staticAnalysis'], 'toolError')
        self.assertEqual(report['status'], 'toolError')

    def test_crashing_slither_is_tool_error(self):
        with tempfile.TemporaryDirectory() as d:
            fake = Path(d) / 'slither'
            fake.write_text('#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.11.3; else echo "{}"; fi\n')
            fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
            report = validate_development_detailed(spec(), bundle(), slither_path=str(fake))[0]
        self.assertEqual(statuses(report)['staticAnalysis'], 'toolError')
        self.assertEqual(report['status'], 'toolError')


if __name__ == '__main__':
    unittest.main()
