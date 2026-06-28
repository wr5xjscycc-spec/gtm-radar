# tests/integration/ — cross-lane integration tests

End-to-end and cross-lane tests that exercise the contract using **recorded fixtures** (never live API calls). This is where the milestone checks live:

- thin-slice (Phase 0), measurement gut-punch (Phase 3), day-1 product (Phase 4), closed loop / lift-with-CI (Phase 5), and the honesty assertions (no causal output without a `lift_result`).

`fixtures/` holds one seed example per record type (`docs/CONTRACT.md`) so every lane can develop and test without waiting on upstream lanes. Add a recorded vendor/engine response here whenever a lane needs an integration test.

Owned jointly by all lanes (see `../../.github/CODEOWNERS`).
