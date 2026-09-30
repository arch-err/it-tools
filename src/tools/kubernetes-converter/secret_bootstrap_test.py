import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('secret-bootstrap.py')
spec = importlib.util.spec_from_file_location('secret_bootstrap', SCRIPT)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class SecretImportTest(unittest.TestCase):
    def invoke(self, input_value, references, dry_run=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'secret-references.json').write_text(json.dumps(references))
            source = root / 'input.json'
            source.write_text(json.dumps(input_value))
            argv = ['import-secrets.py', str(source)] + (['--dry-run'] if dry_run else [])
            output = io.StringIO()
            with patch.object(bootstrap, '__file__', str(root / 'import-secrets.py')), patch.object(sys, 'argv', argv), patch.object(bootstrap.subprocess, 'run') as run, contextlib.redirect_stdout(output):
                self.last_run = run
                bootstrap.main()
                return run.call_args_list, output.getvalue()

    def test_decodes_bytes_and_stringdata_precedence_over_stdin_only(self):
        input_value = {'kind': 'List', 'items': [{'kind': 'Secret', 'metadata': {'namespace': 'test', 'name': 'secret'}, 'data': {'password': base64.b64encode(b'old').decode(), 'binary': base64.b64encode(b'\x00\xff\n').decode()}, 'stringData': {'password': 'new-private-value'}}]}
        refs = [{'namespace': 'test', 'name': 'secret', 'key': key, 'podmanName': 'ref-' + key} for key in ['password', 'binary']]
        calls, output = self.invoke(input_value, refs)
        self.assertEqual(calls[0].kwargs['input'], b'new-private-value')
        self.assertEqual(calls[1].kwargs['input'], b'\x00\xff\n')
        self.assertEqual(calls[0].args[0], ['podman', 'secret', 'create', '--replace', 'ref-password', '-'])
        self.assertNotIn('new-private-value', output)
        self.assertNotIn('new-private-value', str(calls[0].args))

    def test_validates_all_references_before_mutating(self):
        data = [{'kind': 'Secret', 'metadata': {'name': 'secret'}, 'stringData': {'password': 'value'}}]
        refs = [{'namespace': 'default', 'name': 'secret', 'key': key, 'podmanName': key} for key in ['password', 'missing']]
        with self.assertRaises(ValueError):
            self.invoke(data, refs)
        self.last_run.assert_not_called()

    def test_dry_run_does_not_change_podman(self):
        calls, _ = self.invoke({'kind': 'Secret', 'metadata': {'name': 'secret'}, 'stringData': {'key': 'value'}}, [{'namespace': 'default', 'name': 'secret', 'key': 'key', 'podmanName': 'ref'}], True)
        self.assertEqual(calls, [])

    def test_rejects_invalid_base64_and_empty_runtime_secrets(self):
        for value in ['not base64!', '']:
            with self.assertRaises(ValueError):
                self.invoke({'kind': 'Secret', 'metadata': {'name': 'secret'}, 'data': {'key': value}}, [{'namespace': 'default', 'name': 'secret', 'key': 'key', 'podmanName': 'ref'}])


if __name__ == '__main__':
    unittest.main()
