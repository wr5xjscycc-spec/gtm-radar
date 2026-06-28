import { describe, it, expect } from "vitest";
import { score, headline, formatPcitedCI, measurementProgress } from "../src/gutPunch";

describe("gut-punch formatters", () => {
  it("score renders cited/total", () => {
    expect(score({ cited: 0, total: 12 })).toBe("0 / 12");
  });

  it("headline shows you vs top competitor", () => {
    expect(
      headline({ cited: 0, total: 1 }, { domain: "competitor.com", cited: 1, total: 1 }),
    ).toBe("you 0 / 1 · top competitor competitor.com 1/1");
  });

  it("headline with no competitor", () => {
    expect(headline({ cited: 2, total: 3 }, null)).toBe("you 2 / 3");
  });

  it("formatPcitedCI shows the rate WITH its CI (uncertainty visible)", () => {
    expect(formatPcitedCI(0.33, 0.12, 0.61)).toBe("33% (CI 12%–61%)");
  });

  it("formatPcitedCI falls back to bare rate without a CI, and dash when absent", () => {
    expect(formatPcitedCI(0.5)).toBe("50%");
    expect(formatPcitedCI(null)).toBe("—");
  });

  it("measurementProgress reports done/total/pct", () => {
    expect(measurementProgress([{}, {}], 4)).toEqual({ done: 2, total: 4, pct: 50 });
    expect(measurementProgress([{}, {}])).toEqual({ done: 2, total: 2, pct: 100 });
  });
});
