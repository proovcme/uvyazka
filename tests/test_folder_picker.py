import base64
import os
from pathlib import Path
from types import SimpleNamespace
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from uvyazka import folder_picker


class FolderPickerTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'PowerShell parser check is Windows-specific')
    def test_windows_dialog_script_parses_without_opening_a_window(self):
        shell=Path(os.environ.get('SystemRoot',r'C:\Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'
        if not shell.is_file():self.skipTest('Windows PowerShell not installed')
        script=base64.b64encode(folder_picker.WINDOWS_SCRIPT.encode('utf-8')).decode('ascii')
        command=("$folderSyntaxErrors=$null; $folderSyntaxTokens=$null; "
                 "[void][System.Management.Automation.Language.Parser]::ParseInput("
                 "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+script+"')),"
                 "[ref]$folderSyntaxTokens,[ref]$folderSyntaxErrors); "
                 "if($folderSyntaxErrors.Count){$folderSyntaxErrors | Out-String; exit 1}")
        result=subprocess.run([str(shell),'-NoProfile','-NonInteractive','-Command',command],capture_output=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stdout.decode('utf-8',errors='replace'))

    def test_selected_unicode_path_is_returned_without_reading_its_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/"Проект ПД";source.mkdir()
            result=SimpleNamespace(returncode=0,stdout=base64.b64encode(str(source).encode('utf-8')))
            with patch.object(folder_picker,'available',return_value=True), patch.object(folder_picker.subprocess,'run',return_value=result) as run:
                selected=folder_picker.select_folder(str(source))
            self.assertEqual(selected,{'cancelled':False,'source_root':str(source.resolve())})
            command=run.call_args.args[0]
            self.assertIn('-STA',command)
            self.assertNotIn(str(source),command)
            self.assertEqual(run.call_args.kwargs['env']['UVYAZKA_PICKER_INITIAL'],str(source))

    def test_cancel_failure_timeout_and_non_windows_do_not_register_anything(self):
        with patch.object(folder_picker,'available',return_value=False):
            with self.assertRaises(ValueError):folder_picker.select_folder()
        with patch.object(folder_picker,'available',return_value=True):
            with patch.object(folder_picker.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=b'')):
                self.assertEqual(folder_picker.select_folder(),{'cancelled':True,'source_root':None})
            for result in (SimpleNamespace(returncode=1,stdout=b''),SimpleNamespace(returncode=0,stdout=b'not base64')):
                with patch.object(folder_picker.subprocess,'run',return_value=result):
                    with self.assertRaises(ValueError):folder_picker.select_folder()
            with patch.object(folder_picker.subprocess,'run',side_effect=subprocess.TimeoutExpired('picker',600)):
                with self.assertRaises(ValueError):folder_picker.select_folder()
            with patch.object(folder_picker.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=b'')):
                self.assertTrue(folder_picker.select_folder()['cancelled'])

    def test_only_one_dialog_is_opened(self):
        with patch.object(folder_picker,'available',return_value=True),patch.object(folder_picker.subprocess,'run') as run:
            folder_picker._dialog.acquire()
            try:
                with self.assertRaises(ValueError):folder_picker.select_folder()
                run.assert_not_called()
            finally:folder_picker._dialog.release()
