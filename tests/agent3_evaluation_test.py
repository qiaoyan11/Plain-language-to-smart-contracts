import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from agent3 import evaluate
from agent3.model import ModelError


class LiveEvaluationAccountingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cases = json.loads(evaluate.CASES_PATH.read_text())
        cls.cases = [next(c for c in cases if c['id'] == case_id) for case_id in ('en-02', 'en-09')]
        cls.deposit = ({'kind': 'deposit', 'milestoneId': None, 'language': 'en'}, {})

    def evaluate_offline(self, responses):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cases_path = root / 'cases.json'
            cases_path.write_text(json.dumps(self.cases))
            receipts_path = root / 'receipts.json'
            receipts_path.write_text('[]')
            output = io.StringIO()
            with (patch.object(evaluate, 'ROOT', root),
                  patch.object(evaluate, 'CASES_PATH', cases_path),
                  patch.object(evaluate, 'RECEIPTS_PATH', receipts_path),
                  patch.object(evaluate, 'call_model', side_effect=responses),
                  redirect_stdout(output), redirect_stderr(io.StringIO())):
                exit_code = evaluate.main()
            report_path, = (root / 'artifacts' / 'agent3').glob('*/report.json')
            return exit_code, json.loads(report_path.read_text()), output.getvalue()

    def test_outage_never_scores_fallback_refusals(self):
        exit_code, report, output = self.evaluate_offline([ModelError('offline'), ModelError('offline')])
        self.assertEqual(exit_code, 1)
        self.assertTrue(report['incomplete'])
        self.assertEqual(report['modelAttempts'], 2)
        self.assertEqual(report['modelErrors'], 2)
        self.assertEqual(report['validCases'], 0)
        self.assertEqual(report['correct'], 0)
        self.assertIsNone(report['accuracy'])
        for row in report['results']:
            self.assertEqual(row['got']['status'], 'blocked')
            self.assertIsNone(row['correct'])
            self.assertIn('error', row)
        self.assertIn('accuracy=unavailable', output)

    def test_partial_error_preserves_only_valid_case_scores(self):
        exit_code, report, _ = self.evaluate_offline([self.deposit, ModelError('timeout')])
        self.assertEqual(exit_code, 1)
        self.assertTrue(report['incomplete'])
        self.assertEqual(report['modelAttempts'], 2)
        self.assertEqual(report['modelErrors'], 1)
        self.assertEqual(report['validCases'], 1)
        self.assertEqual(report['correct'], 1)
        self.assertIsNone(report['accuracy'])
        self.assertEqual([r['correct'] for r in report['results']], [True, None])
        self.assertEqual((report['unsafe'], report['critical']), (0, 0))

    def test_complete_run_reports_accuracy_and_succeeds(self):
        exit_code, report, output = self.evaluate_offline([self.deposit, self.deposit])
        self.assertEqual(exit_code, 0)
        self.assertFalse(report['incomplete'])
        self.assertEqual(report['modelAttempts'], 2)
        self.assertEqual(report['modelErrors'], 0)
        self.assertEqual(report['validCases'], 2)
        self.assertEqual(report['correct'], 2)
        self.assertEqual(report['accuracy'], 1.0)
        self.assertIn('accuracy=100.0%', output)
