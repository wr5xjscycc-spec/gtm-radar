# analysis/ — Lane P4 (Intelligence & Loop)

The protected core (separate Python service, called by a Convex action): the **Bayesian hypothesis generator** (honest, uncertainty-flagged), the **randomized matched-pair difference-in-differences experiment engine**, the **interventional dataset** (the moat), plus asset generation + 3-tier delivery + CMS publish.

- Brief: [`../docs/phase-cards/P4-Intelligence-and-Loop.md`](../docs/phase-cards/P4-Intelligence-and-Loop.md)
- Writes `model_fit`, `experiment`, `lift_result`, `intervention` (see `../docs/CONTRACT.md`).
- Tests: `pip install -r requirements.txt && pytest` (run from repo root: `pytest analysis`).
- **Stats are tested on synthetic data with known ground truth** — that's how we prove honesty.
- Non-negotiables: correlation≠causation (no causal output without a `lift_result`); effective N = #companies.
