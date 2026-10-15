"""Source-checkout entrypoint for local plugin hosts. Install dependencies first."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
from uvyazka.server import main

main()
