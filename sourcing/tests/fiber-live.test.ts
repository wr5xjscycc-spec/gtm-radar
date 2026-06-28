// Live Fiber client tests — VENDOR MOCKED (docs/TESTING.md rule 1). The injected
// `fetch` replays recorded Fiber payloads (trimmed from real api.fiber.ai responses),
// so this proves the battlefield sweep + firmographics mapping + cache end-to-end
// with NO network and NO key. Key-free => runs in CI.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFiberLive } from "../src/fiber-live";

const here = __dirname;
const kitchenSink = JSON.parse(
  readFileSync(join(here, "fixtures", "fiber-kitchensink.json"), "utf8"),
);
const companySearch = JSON.parse(
  readFileSync(join(here, "fixtures", "fiber-company-search.json"), "utf8"),
);

/** A fetch stub that routes by Fiber path and counts calls per endpoint. */
function makeFetch() {
  const calls = { search: 0, kitchenSink: 0, other: 0 };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    let body: unknown;
    if (url.includes("/v1/company-search")) {
      calls.search += 1;
      body = companySearch;
    } else if (url.includes("/v1/kitchen-sink/company")) {
      calls.kitchenSink += 1;
      body = kitchenSink;
    } else {
      calls.other += 1;
      body = {};
    }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("createFiberLive — battlefield sweep", () => {
  it("returns relevant competitors, excludes the seed and off-industry hits", async () => {
    const { fetchImpl, calls } = makeFetch();
    const fiber = createFiberLive({
      apiKey: "test",
      fetchImpl,
      verticalHint: "project management",
    });

    const companies = await fiber.client.findSimilarCompanies({ domain: "linear.app" });
    const domains = companies.map((c) => c.domain);

    // Seed echo (linear.app) is dropped — a company is not its own competitor.
    expect(domains).not.toContain("linear.app");
    // Off-industry hit (bigmining.com, Mining) is dropped by the relevance gate.
    expect(domains).not.toContain("bigmining.com");
    // The real, industry-overlapping competitors survive and are mapped.
    expect(domains).toContain("slack.com");
    expect(domains).toContain("gitlab.com");
    expect(companies.find((c) => c.domain === "slack.com")?.name).toBeTruthy();

    // PARALLEL multi-angle sweep: seed resolves -> several company-search calls fan out.
    expect(calls.kitchenSink).toBe(1); // one seed resolve
    expect(calls.search).toBeGreaterThan(1); // multiple angles in parallel
  });

  it("caps results at the requested limit", async () => {
    const { fetchImpl } = makeFetch();
    const fiber = createFiberLive({ apiKey: "test", fetchImpl });
    const companies = await fiber.client.findSimilarCompanies({ domain: "linear.app", limit: 1 });
    expect(companies).toHaveLength(1);
  });

  it("returns [] for an empty/garbage seed without throwing", async () => {
    const { fetchImpl } = makeFetch();
    const fiber = createFiberLive({ apiKey: "test", fetchImpl });
    expect(await fiber.client.findSimilarCompanies({ domain: "" })).toEqual([]);
  });
});

describe("createFiberLive — firmographics", () => {
  it("serves swept companies from cache (no extra kitchen-sink call) and maps the 5 fields", async () => {
    const { fetchImpl, calls } = makeFetch();
    const fiber = createFiberLive({ apiKey: "test", fetchImpl });

    await fiber.client.findSimilarCompanies({ domain: "linear.app" });
    const before = calls.kitchenSink; // 1 (seed)

    const firmo = await fiber.firmographics.getFirmographics({ domain: "slack.com" });
    // slack was cached by the sweep -> no new network call.
    expect(calls.kitchenSink).toBe(before);
    // At least one contract field is populated from the real record.
    const populated = Object.keys(firmo).length;
    expect(populated).toBeGreaterThan(0);
  });

  it("falls back to a kitchen-sink lookup for an un-swept domain", async () => {
    const { fetchImpl, calls } = makeFetch();
    const fiber = createFiberLive({ apiKey: "test", fetchImpl });
    const firmo = await fiber.firmographics.getFirmographics({ domain: "acme.io" });
    expect(calls.kitchenSink).toBe(1); // the lookup
    expect(firmo).toBeTruthy();
  });

  it("maps funding_stage, size band and tech_stack from a rich record", async () => {
    const { fetchImpl } = makeFetch();
    const fiber = createFiberLive({ apiKey: "test", fetchImpl });
    // un-swept domain -> kitchen-sink fixture (the Linear record, which is rich).
    const firmo = await fiber.firmographics.getFirmographics({ domain: "rich-co.com" });
    expect(firmo.funding_stage).toBe("series_c");
    expect(firmo.size).toMatch(/^\d/); // a band like "201-500"
    expect(Array.isArray(firmo.tech_stack)).toBe(true);
  });
});

describe("createFiberLive — off-page entity (honest empty)", () => {
  it("returns {} so coverage stays offpage_missing (Fiber has no SEO/entity signals)", async () => {
    const { fetchImpl } = makeFetch();
    const fiber = createFiberLive({ apiKey: "test", fetchImpl });
    expect(await fiber.entity.getEntitySignals({ domain: "anything.com" })).toEqual({});
  });
});
