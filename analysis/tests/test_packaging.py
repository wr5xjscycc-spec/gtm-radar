"""Validate the OSS methodology-core packaging config.

Fast checks only: parse pyproject metadata and confirm the public methodology
modules import. We deliberately do NOT run `python -m build` here (too slow/heavy
for CI) — the orchestrator does the real build+install verification separately.
"""

from __future__ import annotations

import importlib
import tomllib
from pathlib import Path

import pytest

PYPROJECT = Path(__file__).parent.parent / "pyproject.toml"


@pytest.fixture(scope="module")
def pyproject() -> dict:
    with PYPROJECT.open("rb") as fh:
        return tomllib.load(fh)


def test_pyproject_is_well_formed(pyproject: dict) -> None:
    # Both tables required for a buildable, installable package.
    assert "build-system" in pyproject, "missing [build-system]"
    assert "project" in pyproject, "missing [project]"


def test_build_system_uses_setuptools(pyproject: dict) -> None:
    build = pyproject["build-system"]
    assert build.get("build-backend") == "setuptools.build_meta"
    requires = " ".join(build.get("requires", []))
    assert "setuptools" in requires
    assert "wheel" in requires


def test_project_metadata(pyproject: dict) -> None:
    proj = pyproject["project"]
    assert proj.get("name") == "gtm-radar-analysis"
    # version must be set and non-placeholder.
    version = proj.get("version", "")
    assert version and version != "0.0.0", "version must be set"
    assert proj.get("description")
    assert proj.get("requires-python"), "requires-python must be declared"
    assert ">=3.11" in proj["requires-python"]


def test_core_runtime_deps_present(pyproject: dict) -> None:
    deps = " ".join(pyproject["project"].get("dependencies", []))
    # The methodology core must pull its own math/stats stack.
    for pkg in ("numpy", "pandas", "statsmodels", "pymc"):
        assert pkg in deps, f"core runtime dep missing: {pkg}"


def test_service_and_test_are_optional_not_core(pyproject: dict) -> None:
    proj = pyproject["project"]
    core = " ".join(proj.get("dependencies", []))
    extras = proj.get("optional-dependencies", {})
    # fastapi/uvicorn/httpx/pytest must NOT be hard runtime deps of the OSS core.
    for pkg in ("fastapi", "uvicorn", "httpx", "pytest"):
        assert pkg not in core, f"{pkg} should be an extra, not a core dep"
    assert "service" in extras, "missing [service] extra"
    assert "test" in extras, "missing [test] extra"
    assert any("fastapi" in d for d in extras["service"])
    assert any("pytest" in d for d in extras["test"])


def test_tests_and_fixtures_excluded_from_package(pyproject: dict) -> None:
    find = pyproject["tool"]["setuptools"]["packages"]["find"]
    # Only the `src` methodology package ships.
    assert any(p.startswith("src") for p in find.get("include", []))
    excluded = find.get("exclude", [])
    # The data moat (tests + interventional-style fixtures) must be excluded.
    assert any(e.startswith("tests") for e in excluded), "tests not excluded"
    assert any("fixtures" in e for e in excluded), "fixtures not excluded"


def test_pytest_config_preserved(pyproject: dict) -> None:
    # The existing pytest config that makes `import src...` work must survive.
    ini = pyproject["tool"]["pytest"]["ini_options"]
    assert ini.get("pythonpath") == ["."]
    assert ini.get("testpaths") == ["tests"]


@pytest.mark.parametrize(
    "module",
    [
        "src",
        "src.assembly",
        "src.matching",
        "src.features",
        "src.labeling",
        "src.rows",
        "src.bayes",
        "src.hypotheses",
        "src.did",
        "src.experiment",
        "src.delivery",
        "src.moat",
        "src.contract",
    ],
)
def test_public_methodology_modules_importable(module: str) -> None:
    assert importlib.import_module(module) is not None
