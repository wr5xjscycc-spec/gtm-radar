# Product

## Register

product

## Users

B2B SaaS founders and their growth/marketing leads. They suspect AI answer engines
(ChatGPT, Perplexity, Gemini) are recommending competitors instead of them, but have
no way to see it. They arrive anxious and skeptical of "AI visibility" snake oil, and
they leave only if the numbers are real. Context of use: a focused desktop session,
once per measurement cycle, reviewing evidence and deciding whether to ship a fix.

## Product Purpose

Radar measures whether AI answer engines cite a company for its buyers' real questions,
explains why competitors are winning, generates an AI-optimized page to fix it, then
runs a randomized experiment to prove whether the fix actually moved the citation rate.
Success is the founder trusting a causal lift number enough to act on it, because every
claim is backed by a measurement they can inspect.

The product is one workspace lifecycle across three surfaces:
1. **Wizard** — onboarding → site read → live citation scan → ranked hypotheses → next move
2. **Asset page** — the generated comparison page, ready to publish
3. **Lift report** — the causal experiment result, weeks later

## Brand Personality

Evidence-first, calm, and unflinchingly honest. Three words: **measured, credible, sharp.**
The voice states what was measured and what it means, never what the user wants to hear.
It shows uncertainty (confidence intervals) instead of hiding it, and it refuses to claim
a win it can't back. The emotional arc is gut-punch (you're losing) → clarity (here's why)
→ earned confidence (here's the proof it worked).

## Anti-references

- Generic "AI marketing dashboard" slop: rainbow gradient hero metrics, vanity scores,
  confetti, growth-hacking hype.
- Tools that present a single blended "AI visibility score" with no methodology. Radar
  never collapses per-engine numbers into one figure without labeling it an aggregate.
- Anything that implies causation from correlation ("add this and you'll rank #1").
  Overclaiming is the category's original sin and Radar's foil.

## Design Principles

- **Practice what you preach.** A product whose thesis is honest measurement must itself
  never overclaim. The claim ladder (measured → hypothesis → causal) is enforced in the
  UI: causal language is impossible to render without a `lift_result`.
- **Show the uncertainty, not just the point estimate.** Every rate ships with its CI;
  every hypothesis ships with its noise flag. Confidence is earned by exposing the math,
  not by rounding it away.
- **Per-engine, never silently blended.** ChatGPT, Perplexity, and Gemini are independent;
  any combined number is explicitly labeled an aggregate.
- **Reactive truth.** The board fills in live as the pipeline writes rows. Loading states
  teach what is happening ("reading your site", "sweeping 40/300 queries"), never spin blankly.
- **Earned familiarity over novelty.** This is a task tool. It should feel like Linear or
  Stripe: the interface disappears and the evidence is the hero.

## Accessibility & Inclusion

Target WCAG 2.1 AA. Body text ≥ 4.5:1, large/bold text ≥ 3:1. All inputs have associated
labels; all interactive controls are real buttons/inputs with visible keyboard focus.
Color is never the sole signal (the you/competitor and worked/no-effect/inconclusive
states carry text + icon, not just green/red). All motion has a `prefers-reduced-motion`
fallback. Light theme only, tuned for a bright office display.
