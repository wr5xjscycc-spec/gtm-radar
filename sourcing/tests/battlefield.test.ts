// P3 · Phase 1 required test: battlefield mapping tests. Exercises the full
// company-layer builder — role tagging (customer / competitor / battlefield),
// explicit precedence, normalization, and dedup — with the Fiber vendor MOCKED
// (no live network, docs/TESTING.md rule 1).

import { describe, it, expect } from "vitest";

import {
  buildCompanyLayer,
  roleFor,
  type CompanyWriter,
} from "../src/battlefield";
import { FIBER_BATTLEFIELD_VERSION, type FiberClient, type FiberCompany } from "../src/fiber";
import { isNormalizedDomain } from "../src/domain";
import type { Company } from "../src/types";

/** In-memory stand-in for P1's Convex `company` upsert (keyed on normalized domain). */
class InMemoryCompanyWriter implements CompanyWriter {
  readonly byDomain = new Map<string, Company>();
  async upsertCompany(company: Company): Promise<void> {
    this.byDomain.set(company.domain, company);
  }
}

/** Build a mock Fiber client from a fixed list of results — NEVER hits the network. */
function mockFiber(companies: FiberCompany[]): FiberClient {
  return {
    async findSimilarCompanies() {
      return companies;
    },
  };
}

/** Synthesize N distinct battlefield companies (to prove 20–40 isn't truncated). */
function manyCompanies(n: number): FiberCompany[] {
  return Array.from({ length: n }, (_, i) => ({
    domain: `company${i}.com`,
    name: `Company ${i}`,
  }));
}

describe("roleFor (pure precedence)", () => {
  const ctx = {
    customerDomain: "https://www.Linear.app/",
    competitorDomains: ["Asana.com", "https://monday.com/pricing"],
  };

  it("tags the customer's own domain as customer", () => {
    expect(roleFor("linear.app", ctx)).toBe("customer");
    expect(roleFor("WWW.Linear.app", ctx)).toBe("customer");
  });

  it("tags known competitors as competitor (messy inputs normalized)", () => {
    expect(roleFor("https://www.asana.com/", ctx)).toBe("competitor");
    expect(roleFor("monday.com", ctx)).toBe("competitor");
  });

  it("tags everything else as battlefield", () => {
    expect(roleFor("clickup.com", ctx)).toBe("battlefield");
  });

  it("customer precedence beats competitor when a domain is in both", () => {
    expect(
      roleFor("linear.app", {
        customerDomain: "linear.app",
        competitorDomains: ["linear.app"],
      }),
    ).toBe("customer");
  });
});

describe("buildCompanyLayer (role tagging + precedence)", () => {
  it("tags the customer, present in output and NOT excluded", async () => {
    const writer = new InMemoryCompanyWriter();
    const rows = await buildCompanyLayer(mockFiber([{ domain: "asana.com", name: "Asana" }]), writer, {
      customerDomain: "linear.app",
      customerName: "Linear",
      competitorDomains: ["asana.com"],
    });

    const customer = writer.byDomain.get("linear.app");
    expect(customer).toBeDefined();
    expect(customer!.role).toBe("customer");
    expect(customer!.name).toBe("Linear");
    expect(rows.some((c) => c.domain === "linear.app")).toBe(true);
  });

  it("a domain in BOTH the competitor list and Fiber results resolves to competitor", async () => {
    const writer = new InMemoryCompanyWriter();
    await buildCompanyLayer(
      mockFiber([
        { domain: "asana.com", name: "Asana" }, // also a known competitor
        { domain: "clickup.com", name: "ClickUp" }, // battlefield only
      ]),
      writer,
      { customerDomain: "linear.app", competitorDomains: ["asana.com"] },
    );

    expect(writer.byDomain.get("asana.com")!.role).toBe("competitor");
    expect(writer.byDomain.get("clickup.com")!.role).toBe("battlefield");
  });

  it("writes competitors even when Fiber never returned them", async () => {
    const writer = new InMemoryCompanyWriter();
    await buildCompanyLayer(mockFiber([{ domain: "clickup.com", name: "ClickUp" }]), writer, {
      customerDomain: "linear.app",
      competitorDomains: ["asana.com", "monday.com"],
    });

    expect(writer.byDomain.get("asana.com")!.role).toBe("competitor");
    expect(writer.byDomain.get("monday.com")!.role).toBe("competitor");
    expect(writer.byDomain.get("clickup.com")!.role).toBe("battlefield");
  });

  it("borrows a Fiber name for a competitor that lacked one, keeping role=competitor", async () => {
    const writer = new InMemoryCompanyWriter();
    await buildCompanyLayer(mockFiber([{ domain: "asana.com", name: "Asana" }]), writer, {
      customerDomain: "linear.app",
      competitorDomains: ["asana.com"], // no name supplied -> placeholder == domain
    });

    const asana = writer.byDomain.get("asana.com")!;
    expect(asana.role).toBe("competitor");
    expect(asana.name).toBe("Asana");
  });
});

describe("buildCompanyLayer (normalization + dedup)", () => {
  it("normalizes messy customer/competitor/Fiber inputs to clean keys", async () => {
    const writer = new InMemoryCompanyWriter();
    const rows = await buildCompanyLayer(
      mockFiber([{ domain: "https://CLICKUP.com/features?ref=x", name: "ClickUp" }]),
      writer,
      {
        customerDomain: "https://www.Linear.app/",
        competitorDomains: ["HTTPS://www.Asana.com/", "Monday.com/"],
      },
    );

    for (const c of rows) {
      expect(isNormalizedDomain(c.domain), `not normalized: ${c.domain}`).toBe(true);
    }
    expect(writer.byDomain.has("linear.app")).toBe(true);
    expect(writer.byDomain.has("asana.com")).toBe(true);
    expect(writer.byDomain.has("monday.com")).toBe(true);
    expect(writer.byDomain.has("clickup.com")).toBe(true);
  });

  it("dedupes across customer / competitor / battlefield — no domain appears twice", async () => {
    const writer = new InMemoryCompanyWriter();
    const rows = await buildCompanyLayer(
      mockFiber([
        { domain: "https://www.Asana.com/", name: "Asana" }, // competitor echoed by Fiber
        { domain: "asana.com", name: "Asana dup" }, // apex dup of the same
        { domain: "www.linear.app", name: "Linear echo" }, // customer echoed back
        { domain: "clickup.com", name: "ClickUp" },
      ]),
      writer,
      { customerDomain: "linear.app", competitorDomains: ["asana.com"] },
    );

    // one row per normalized domain
    const domains = rows.map((c) => c.domain);
    expect(new Set(domains).size).toBe(domains.length);
    expect(rows.filter((c) => c.domain === "asana.com").length).toBe(1);
    expect(rows.filter((c) => c.domain === "linear.app").length).toBe(1);
    // roles survive the dedup
    expect(writer.byDomain.get("asana.com")!.role).toBe("competitor");
    expect(writer.byDomain.get("linear.app")!.role).toBe("customer");
  });
});

describe("buildCompanyLayer (scale + record shape)", () => {
  it("handles a ~25-company Fiber result without truncating (20–40 support)", async () => {
    const writer = new InMemoryCompanyWriter();
    const rows = await buildCompanyLayer(mockFiber(manyCompanies(25)), writer, {
      customerDomain: "linear.app",
      competitorDomains: ["asana.com", "monday.com", "clickup.com"],
    });

    const battlefield = rows.filter((c) => c.role === "battlefield");
    const competitors = rows.filter((c) => c.role === "competitor");
    const customers = rows.filter((c) => c.role === "customer");

    expect(battlefield.length).toBe(25); // every synthetic Fiber hit, none dropped
    expect(competitors.length).toBe(3);
    expect(customers.length).toBe(1);
    expect(rows.length).toBe(29); // 25 battlefield + 3 competitor + 1 customer
    expect(writer.byDomain.size).toBe(rows.length);
  });

  it("every row has a role, the battlefield source version, and all coverage families flagged missing", async () => {
    const writer = new InMemoryCompanyWriter();
    const rows = await buildCompanyLayer(mockFiber(manyCompanies(22)), writer, {
      customerDomain: "linear.app",
      competitorDomains: ["asana.com"],
    });

    for (const c of rows) {
      expect(c.role).toBeDefined();
      expect(["customer", "competitor", "battlefield"]).toContain(c.role);
      // Provenance honesty: only Fiber-discovered battlefield rows carry the
      // battlefield source version; customer/competitor come from the P1 record.
      if (c.role === "battlefield") {
        expect(c.source_versions.battlefield).toBe(FIBER_BATTLEFIELD_VERSION);
      } else {
        expect(c.source_versions.battlefield).toBeUndefined();
      }
      expect(c.coverage_flags).toMatchObject({
        firmographics_missing: true,
        offpage_missing: true,
        understanding_missing: true,
      });
    }
  });

  it("forwards the normalized seed + limit to Fiber", async () => {
    const calls: unknown[] = [];
    const spyFiber: FiberClient = {
      async findSimilarCompanies(args) {
        calls.push(args);
        return [];
      },
    };
    await buildCompanyLayer(spyFiber, new InMemoryCompanyWriter(), {
      customerDomain: "https://www.Linear.app/",
      limit: 30,
    });
    expect(calls[0]).toEqual({ domain: "linear.app", limit: 30 });
  });
});
