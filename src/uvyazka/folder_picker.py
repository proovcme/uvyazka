"""User-invoked Windows folder selection returns a path, never file bytes."""
import base64
import os
from pathlib import Path
import subprocess
import threading

_dialog = threading.Lock()
PICKER_REVISION = "native-folder-picker-1"
WINDOWS_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
try {
    $owner.ShowInTaskbar = $false
    $owner.TopMost = $true
    $owner.Opacity = 0
    $owner.Width = 1
    $owner.Height = 1
    $owner.StartPosition = 'CenterScreen'
    $owner.Show()
    $picker.Description = 'Выберите существующую папку проекта. Файлы останутся на месте.'
    $picker.ShowNewFolderButton = $false
    $picker.SelectedPath = [Environment]::GetFolderPath('MyDocuments')
    if ($env:UVYAZKA_PICKER_INITIAL) { $picker.SelectedPath = $env:UVYAZKA_PICKER_INITIAL }
    if ($picker.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($picker.SelectedPath)))
    }
} finally {
    $picker.Dispose()
    $owner.Dispose()
}
"""


def available():
    return os.name == "nt"


def select_folder(initial_path=""):
    if not available():
        raise ValueError("Системный выбор папки доступен в Windows; укажите полный путь вручную")
    if not isinstance(initial_path, str) or len(initial_path) > 32760 or "\x00" in initial_path:
        raise ValueError("Некорректный начальный путь")
    if not _dialog.acquire(blocking=False):
        raise ValueError("Окно выбора папки уже открыто")
    try:
        shell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        encoded = base64.b64encode(WINDOWS_SCRIPT.encode("utf-16-le")).decode("ascii")
        try:
            result = subprocess.run([str(shell), "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
                                    env={**os.environ, "UVYAZKA_PICKER_INITIAL": initial_path},
                                    capture_output=True, timeout=600,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired as exc:
            raise ValueError("Выбор папки завершён по времени; попробуйте снова или укажите путь") from exc
        if result.returncode:
            raise ValueError("Не удалось открыть системное окно выбора папки; укажите полный путь вручную")
        raw = result.stdout.strip()
        if not raw:
            return {"cancelled": True, "source_root": None}
        try:
            selected = base64.b64decode(raw, validate=True).decode("utf-8")
        except (ValueError, UnicodeError) as exc:
            raise ValueError("Системный выбор вернул некорректный путь") from exc
        if not selected or "\x00" in selected or not Path(selected).is_absolute() or not Path(selected).is_dir():
            raise ValueError("Выбранная папка недоступна")
        return {"cancelled": False, "source_root": str(Path(selected).resolve())}
    finally:
        _dialog.release()
