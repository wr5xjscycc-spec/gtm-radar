// P3 — real-competitor identification (mocked LLM). Proves the parse/clean/dedup
// + anti-hallucination shape end-to-end with NO live vendor call (the ChatModel
// port is mocked, per docs/TESTING.md).
import { describe, it, expect } from "vitest";
import { extractCompetitors, type CompetitorInput } from "../src/competitors";
import type { ChatModel } from "../src/understanding";

function mockModel(reply: string): ChatModel {
  return {
    async complete() {
      return reply;
    },
  };
}

const INPUT: CompetitorInput = {
  domain: "convex.dev",
  name: "Convex",
  category: "serverless database",
  description: "A reactive backend that syncs state across clients.",
};

describe("extractCompetitors", () => {
  it("parses valid JSON into name/domain pairs", async () => {
    const reply = JSON.stringify({
      competitors: [
        { name: "Supabase", domain: "supabase.com" },
        { name: "Firebase", domain: "firebase.google.com" },
      ],
    });
    const r = await extractCompetitors(mockModel(reply), INPUT);
    expect(r.competitors).toEqual([
      { name: "Supabase", domain: "supabase.com" },
      { name: "Firebase", domain: "firebase.google.com" },
    ]);
  });

  it("cleans domains (strips protocol/www/path, lowercases)", async () => {
    const reply = JSON.stringify({
      competitors: [{ name: "Hasura", domain: "https://WWW.Hasura.io/pricing" }],
    });
    const r = await extractCompetitors(mockModel(reply), INPUT);
    expect(r.competitors).toEqual([{ name: "Hasura", domain: "hasura.io" }]);
  });

  it("excludes the company's own domain and de-dupes", async () => {
    const reply = JSON.stringify({
      competitors: [
        { name: "Self", domain: "convex.dev" },
        { name: "Supabase", domain: "supabase.com" },
        { name: "Supabase again", domain: "supabase.com" },
      ],
    });
    const r = await extractCompetitors(mockModel(reply), INPUT);
    expect(r.competitors).toEqual([{ name: "Supabase", domain: "supabase.com" }]);
  });

  it("drops entries without a valid registrable domain", async () => {
    const reply = JSON.stringify({
      competitors: [
        { name: "Bare", domain: "notadomain" },
        { name: "Good", domain: "nhost.io" },
      ],
    });
    const r = await extractCompetitors(mockModel(reply), INPUT);
    expect(r.competitors).toEqual([{ name: "Good", domain: "nhost.io" }]);
  });

  it("falls back to name=domain when name is missing", async () => {
    const reply = JSON.stringify({ competitors: [{ domain: "fauna.com" }] });
    const r = await extractCompetitors(mockModel(reply), INPUT);
    expect(r.competitors).toEqual([{ name: "fauna.com", domain: "fauna.com" }]);
  });

  it("caps the list at 8", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      name: `c${i}`,
      domain: `c${i}.com`,
    }));
    const r = await extractCompetitors(
      mockModel(JSON.stringify({ competitors: many })),
      INPUT,
    );
    expect(r.competitors).toHaveLength(8);
  });

  it("extracts JSON from a chatty / fenced reply", async () => {
    const reply =
      "Here you go:\n```json\n" +
      JSON.stringify({ competitors: [{ name: "A", domain: "a.com" }] }) +
      "\n```";
    const r = await extractCompetitors(mockModel(reply), INPUT);
    expect(r.competitors).toEqual([{ name: "A", domain: "a.com" }]);
  });

  it("is defensive: empty, non-JSON, broken, and wrong-shape all yield []", async () => {
    for (const bad of ["", "sorry, no JSON here", "{not valid json", JSON.stringify({ foo: 1 })]) {
      const r = await extractCompetitors(mockModel(bad), INPUT);
      expect(r.competitors).toEqual([]);
    }
  });
});
