# measurement/ — Lane P2 (Measurement Engine)

The answer-engine layer: adapters for OpenAI (Responses API + `web_search`), Perplexity Sonar, and Gemini grounding; K-repeats → P(cited)+CI; adaptive sampling; citation parsing; case-control labeling; version stamping; drift detection; cost/budget guards.

- Brief: [`../docs/phase-cards/P2-Measurement-Engine.md`](../docs/phase-cards/P2-Measurement-Engine.md)
- Writes `measurement` records (see `../docs/CONTRACT.md`).
- Tests: `npm test` (vitest). **Mock engines in unit tests; recorded fixtures for integration; never live in CI.**
- Non-negotiable: use grounded engines (Responses API + web_search), never plain chat-completions.
