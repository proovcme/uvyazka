"""Build the public read-only demo using generated data, never local projects."""
import os
from pathlib import Path
import shutil
import subprocess
from build_public_demo import export

ROOT = Path(__file__).resolve().parents[1]

if __name__ == '__main__':
    output = ROOT / '.uvyazka-build/public-site/uvyazka'
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    if not npm:
        raise SystemExit('Install Node.js and run npm ci in web first')
    subprocess.run([npm, 'run', 'build', '--', '--base=/uvyazka/', '--outDir', str(output)],
        cwd=ROOT / 'web', env={**os.environ, 'VITE_UVYAZKA_DEMO': '1'}, check=True)
    export(output / 'demo', ROOT / '.uvyazka-build/synthetic-cache')
    print('Public static demo:', output)
