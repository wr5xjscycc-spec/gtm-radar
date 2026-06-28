import { describe, it, expect } from "vitest";
import { companyCardState, battlefieldProgress } from "../src/companyCard";

describe("companyCardState — progressive render (loading -> partial -> ready)", () => {
  it("reading: nothing landed yet", () => {
    const s = companyCardState(undefined);
    expect(s.status).toBe("reading");
    expect(s.isReading).toBe(true);
    expect(s.missing).toContain("category");
  });

  it("reading: empty/whitespace fields don't count", () => {
    expect(companyCardState({ category: "  " }).status).toBe("reading");
  });

  it("partial: some but not all required fields", () => {
    const s = companyCardState({ category: "GTM analytics" });
    expect(s.status).toBe("partial");
    expect(s.fields.category).toBe("GTM analytics");
    expect(s.missing).toContain("positioning");
    expect(s.missing).toContain("what_you_are");
  });

  it("ready: all required (category + positioning + what_you_are) present", () => {
    const s = companyCardState({
      category: "GTM analytics",
      positioning: "AI-answer citation measurement",
      what_you_are: "A tool that measures whether AI answer engines cite you.",
    });
    expect(s.status).toBe("ready");
    expect(s.isReading).toBe(false);
    expect(s.missing).toEqual(["icp"]); // icp is optional, not required
  });

  it("trims field values", () => {
    const s = companyCardState({
      category: "  GTM analytics  ",
      positioning: "x",
      what_you_are: "y",
    });
    expect(s.fields.category).toBe("GTM analytics");
  });
});

describe("battlefieldProgress", () => {
  it("counts battlefield + competitor rows and reports filling", () => {
    const p = battlefieldProgress(
      [{ role: "customer" }, { role: "competitor" }, { role: "battlefield" }],
      20,
    );
    expect(p.count).toBe(2);
    expect(p.filling).toBe(true);
    expect(p.target).toBe(20);
  });

  it("not filling once target reached", () => {
    const rows = Array.from({ length: 22 }, () => ({ role: "battlefield" }));
    expect(battlefieldProgress(rows, 20).filling).toBe(false);
  });
});
