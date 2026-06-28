import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildCompanyUnderstanding } from "../src/understanding";

const mockHomepageHtml = `<!DOCTYPE html>
<html><head><title>ACME Analytics</title></head>
<body>
  <h1>AI-Powered GTM Analytics for PLG Teams</h1>
  <p>ACME Analytics measures whether AI answer engines cite your content.
  Our platform helps B2B SaaS companies optimize for AI search visibility
  and track citation share across ChatGPT, Perplexity, Gemini, and Claude.</p>
</body></html>`;

const mockOpenAIResponse = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          category: "GTM analytics",
          icp: "PLG SaaS growth teams",
          positioning: "AI-answer citation measurement",
          what_you_are:
            "A tool that measures whether AI answer engines cite you.\n" +
            "It tracks citation share across ChatGPT, Perplexity, Gemini, and Claude.\n" +
            "It helps B2B SaaS companies optimize for AI search visibility.\n" +
            "It provides actionable insights to improve citation rates.",
        }),
      },
    },
  ],
};

describe("buildCompanyUnderstanding", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws without an API key", async () => {
    await expect(
      buildCompanyUnderstanding("acme.com", "")
    ).rejects.toThrow("OPENAI_API_KEY");
  });

  it("returns understanding shape from mocked OpenAI", async () => {
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (callCount === 1 && url === "https://acme.com") {
        return {
          ok: true,
          text: async () => mockHomepageHtml,
        };
      }
      if (callCount === 2 && url === "https://api.openai.com/v1/chat/completions") {
        return {
          ok: true,
          json: async () => mockOpenAIResponse,
        };
      }
      return { ok: false, status: 404, statusText: "Not Found", text: async () => "" };
    });

    vi.stubGlobal("fetch", mockFetch);

    const result = await buildCompanyUnderstanding("acme.com", "sk-test-key");

    expect(result).toBeDefined();
    expect(result.category).toBe("GTM analytics");
    expect(result.icp).toBe("PLG SaaS growth teams");
    expect(result.positioning).toBe("AI-answer citation measurement");
    expect(result.what_you_are).toBeTruthy();
    expect(result.what_you_are.length).toBeGreaterThan(10);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("handles OpenAI response with markdown code fences", async () => {
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          text: async () => mockHomepageHtml,
        };
      }
      if (callCount === 2) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content:
                    '```json\n{"category":"CRM","icp":"SMB RevOps","positioning":"affordable alternative","what_you_are":"A simple CRM for small teams."}\n```',
                },
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, statusText: "Not Found", text: async () => "" };
    });

    vi.stubGlobal("fetch", mockFetch);

    const result = await buildCompanyUnderstanding("acme.com", "sk-test-key");
    expect(result.category).toBe("CRM");
    expect(result.icp).toBe("SMB RevOps");
    vi.unstubAllGlobals();
  });

  it("rejects when homepage fetch fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "",
    });

    vi.stubGlobal("fetch", mockFetch);

    await expect(
      buildCompanyUnderstanding("acme.com", "sk-test-key")
    ).rejects.toThrow("Failed to fetch");
    vi.unstubAllGlobals();
  });

  it("rejects when OpenAI response is not valid JSON", async () => {
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          text: async () => mockHomepageHtml,
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "not json at all" } }],
        }),
      };
    });

    vi.stubGlobal("fetch", mockFetch);

    await expect(
      buildCompanyUnderstanding("acme.com", "sk-test-key")
    ).rejects.toThrow("Failed to parse");
    vi.unstubAllGlobals();
  });
});
