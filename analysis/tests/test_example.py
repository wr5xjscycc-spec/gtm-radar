"""Harness smoke test — proves the P4 (pytest) runner works in CI.

Replace/extend per the P4 Testing standard:
  - Convex<->Python round-trip (mocked) returning a model_fit
  - Bayesian recovery on SYNTHETIC data: plant signals -> recover signs; null features -> noise_flag
  - DiD recovery on a simulated panel with a KNOWN lift -> estimate within CI, correct sign
  - power-honesty: returns `inconclusive` at tiny N instead of a false positive
  - honesty-audit: causal output (lift_result) emitted ONLY from the randomized DiD path
"""


def test_harness_runs():
    assert 1 + 1 == 2
