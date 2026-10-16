from pathlib import Path
import uuid
import pytest

@pytest.fixture(scope="session")
def workspace_temp():
    target=Path(__file__).resolve().parents[2]/".uvyazka-build"/"ifccs-tests"/uuid.uuid4().hex
    target.mkdir(parents=True)
    return target
