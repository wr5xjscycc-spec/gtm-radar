// P3 · Phase 2 required test: deterministic parser tests
// (schema/JSON-LD, comparison-table, word-count, headings, freshness, coverage).
//
// Pure functions over HTML/text — no mocks, no network, no LLM. These assert the
// DETERMINISTIC half of `content_features` exactly, since it's the low-noise
// family the model is meant to prefer.

import { describe, it, expect } from "vitest";

import {
  hasSchemaMarkup,
  hasComparisonTable,
  wordCount,
  headingStructure,
  freshnessDays,
  extractLastModified,
  queryTermCoverage,
  extractDeterministicFeatures,
  htmlToText,
} from "../src/parsers";

describe("hasSchemaMarkup", () => {
  it("detects JSON-LD script blocks", () => {
    const html = `<head><script type="application/ld+json">{"@type":"Product"}</script></head>`;
    expect(hasSchemaMarkup(html)).toBe(true);
  });

  it("detects JSON-LD regardless of attribute spacing/quoting", () => {
    const html = `<script  type='application/ld+json' >{}</script>`;
    expect(hasSchemaMarkup(html)).toBe(true);
  });

  it("detects schema.org microdata (itemscope + itemtype)", () => {
    const html = `<div itemscope itemtype="https://schema.org/Product"><span>x</span></div>`;
    expect(hasSchemaMarkup(html)).toBe(true);
  });

  it("is negative for a plain page with no structured data", () => {
    const html = `<html><body><h1>Hello</h1><p>No markup here.</p></body></html>`;
    expect(hasSchemaMarkup(html)).toBe(false);
  });

  it("does NOT count a plain JS script as JSON-LD", () => {
    const html = `<script type="text/javascript">var ld = {};</script>`;
    expect(hasSchemaMarkup(html)).toBe(false);
  });

  it("does NOT count itemscope without a schema.org itemtype", () => {
    const html = `<div itemscope itemtype="https://example.com/Thing"></div>`;
    expect(hasSchemaMarkup(html)).toBe(false);
  });

  it("detects a parameterized media type (charset) on the JSON-LD script", () => {
    const html = `<script type="application/ld+json; charset=utf-8">{"@type":"Product"}</script>`;
    expect(hasSchemaMarkup(html)).toBe(true);
  });
});

describe("hasComparisonTable", () => {
  it("detects a real comparison table (header >=3 cols, >=2 body rows)", () => {
    const html = `
      <table>
        <thead><tr><th>Feature</th><th>Us</th><th>Them</th></tr></thead>
        <tbody>
          <tr><td>Price</td><td>$10</td><td>$20</td></tr>
          <tr><td>SSO</td><td>Yes</td><td>No</td></tr>
        </tbody>
      </table>`;
    expect(hasComparisonTable(html)).toBe(true);
  });

  it("is negative for a layout table (only <td>, no <th>)", () => {
    const html = `
      <table>
        <tr><td>logo</td><td>nav</td></tr>
        <tr><td>sidebar</td><td>content</td></tr>
      </table>`;
    expect(hasComparisonTable(html)).toBe(false);
  });

  it("is negative for a 2-column term/definition table (header but <3 cols)", () => {
    const html = `
      <table>
        <thead><tr><th>Term</th><th>Definition</th></tr></thead>
        <tbody>
          <tr><td>SSO</td><td>Single sign-on</td></tr>
          <tr><td>2FA</td><td>Two-factor auth</td></tr>
        </tbody>
      </table>`;
    expect(hasComparisonTable(html)).toBe(false);
  });

  it("is negative for a header-only table with too few body rows", () => {
    const html = `
      <table>
        <thead><tr><th>Feature</th><th>A</th><th>B</th></tr></thead>
        <tbody><tr><td>Price</td><td>$1</td><td>$2</td></tr></tbody>
      </table>`;
    expect(hasComparisonTable(html)).toBe(false);
  });
});

describe("wordCount", () => {
  it("counts whitespace-delimited words in plain text", () => {
    expect(wordCount("the quick brown fox jumps")).toBe(5);
  });

  it("strips tags when handed HTML", () => {
    expect(wordCount("<p>hello <b>brave</b> world</p>")).toBe(3);
  });

  it("ignores script/style bodies and collapses whitespace", () => {
    const html = `<style>.x{color:red}</style><p>one   two\n\nthree</p><script>var a=1</script>`;
    expect(wordCount(html)).toBe(3);
  });

  it("returns 0 for empty input", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("   ")).toBe(0);
  });
});

describe("headingStructure", () => {
  it("counts h1/h2/h3 occurrences", () => {
    const html = `<h1>T</h1><h2>A</h2><h2>B</h2><h3>x</h3><h3>y</h3><h3>z</h3><h4>nope</h4>`;
    expect(headingStructure(html)).toEqual({ h1: 1, h2: 2, h3: 3 });
  });

  it("is case-insensitive and tolerates attributes", () => {
    const html = `<H1 class="title">T</H1><h2 id="s">S</h2>`;
    expect(headingStructure(html)).toEqual({ h1: 1, h2: 1, h3: 0 });
  });

  it("returns zeros for no headings", () => {
    expect(headingStructure("<p>plain</p>")).toEqual({ h1: 0, h2: 0, h3: 0 });
  });
});

describe("freshnessDays", () => {
  const now = "2026-06-27T00:00:00Z";

  it("computes whole days since the last update with injected now", () => {
    expect(freshnessDays("2026-06-17T00:00:00Z", now)).toBe(10);
  });

  it("accepts a Date for both inputs", () => {
    expect(freshnessDays(new Date("2026-06-26T00:00:00Z"), new Date(now))).toBe(1);
  });

  it("clamps a future modified date to 0 (never negative)", () => {
    expect(freshnessDays("2026-07-10T00:00:00Z", now)).toBe(0);
  });

  it("returns null for a missing date", () => {
    expect(freshnessDays(null, now)).toBeNull();
    expect(freshnessDays(undefined, now)).toBeNull();
  });

  it("returns null for an unparseable date", () => {
    expect(freshnessDays("not-a-date", now)).toBeNull();
  });
});

describe("extractLastModified", () => {
  it("reads article:modified_time meta", () => {
    const html = `<meta property="article:modified_time" content="2026-06-01T12:00:00Z">`;
    expect(extractLastModified(html)).toBe("2026-06-01T12:00:00Z");
  });

  it("falls back to a <time datetime> element", () => {
    const html = `<article><time datetime="2026-05-20">May 20</time></article>`;
    expect(extractLastModified(html)).toBe("2026-05-20");
  });

  it("returns null when no date markup is present", () => {
    expect(extractLastModified("<p>nothing</p>")).toBeNull();
  });
});

describe("queryTermCoverage", () => {
  const text = "Linear is the issue tracker for software teams that ship fast.";

  it("returns 1 when all distinct terms are present", () => {
    expect(queryTermCoverage(text, ["issue tracker", "software"])).toBe(1);
  });

  it("returns the fraction for partial coverage", () => {
    expect(queryTermCoverage(text, ["issue tracker", "kanban"])).toBe(0.5);
  });

  it("is case-insensitive and dedupes repeated terms", () => {
    expect(queryTermCoverage(text, ["LINEAR", "linear", "Software"])).toBe(1);
  });

  it("returns 0 for an empty term list (documented convention)", () => {
    expect(queryTermCoverage(text, [])).toBe(0);
    expect(queryTermCoverage(text, ["   "])).toBe(0);
  });

  it("word-boundary matches single tokens (no substring false positives)", () => {
    // "ai" must NOT match inside "email"/"campaign"; deterministic features are
    // the low-noise lever, so substring inflation would undermine them.
    expect(queryTermCoverage("Send me an email about the campaign.", ["ai"])).toBe(0);
    // but a real standalone token still matches.
    expect(queryTermCoverage("Our AI assistant helps you.", ["ai"])).toBe(1);
  });

  it("still substring-matches multi-word phrases", () => {
    expect(queryTermCoverage("the best issue tracker around", ["issue tracker"])).toBe(1);
  });
});

describe("htmlToText", () => {
  it("strips tags, drops script/style, decodes entities, collapses space", () => {
    const html = `<h1>Hi&amp;Bye</h1><script>x()</script><p>a&nbsp;b</p>`;
    expect(htmlToText(html)).toBe("Hi&Bye a b");
  });
});

describe("extractDeterministicFeatures", () => {
  const now = "2026-06-27T00:00:00Z";
  const html = `
    <html><head>
      <script type="application/ld+json">{"@type":"Article"}</script>
      <meta property="article:modified_time" content="2026-06-20T00:00:00Z">
    </head><body>
      <h1>Best CRM tools</h1><h2>Comparison</h2>
      <table>
        <thead><tr><th>Feature</th><th>A</th><th>B</th></tr></thead>
        <tbody>
          <tr><td>Price</td><td>$1</td><td>$2</td></tr>
          <tr><td>API</td><td>Yes</td><td>No</td></tr>
        </tbody>
      </table>
      <p>The best CRM for sales teams who want pipeline visibility.</p>
    </body></html>`;

  it("assembles the full deterministic vector", () => {
    const f = extractDeterministicFeatures(
      { html, queryTerms: ["crm", "pipeline", "nonexistent"] },
      now,
    );
    expect(f.schema_markup).toBe(true);
    expect(f.comparison_table).toBe(true);
    expect(f.heading_structure).toEqual({ h1: 1, h2: 1, h3: 0 });
    expect(f.word_count).toBeGreaterThan(0);
    expect(f.freshness_days).toBe(7); // 2026-06-20 → 2026-06-27
    expect(f.query_term_coverage).toBeCloseTo(2 / 3, 5);
  });

  it("uses provided text over derived text and falls back to null freshness", () => {
    const f = extractDeterministicFeatures(
      { html: "<p>tiny</p>", text: "alpha beta gamma", queryTerms: ["alpha"] },
      now,
    );
    expect(f.word_count).toBe(3);
    expect(f.freshness_days).toBeNull(); // no lastModified + no meta
    expect(f.query_term_coverage).toBe(1);
  });
});
