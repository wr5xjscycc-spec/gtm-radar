"""Shared P4 test fixtures."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src.service import app

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def fit_request_payload() -> dict:
    """The seed assembled-rows payload a Convex action would POST."""
    return json.loads((FIXTURES / "fit_request.json").read_text())
