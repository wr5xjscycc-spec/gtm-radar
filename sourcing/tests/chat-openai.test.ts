// Card B · task #2 — ChatModel adapter (OpenAI gpt-5-mini) tests.
//
// The adapter is exercised with an INJECTED fake `fetch` returning a canned OpenAI
// Chat Completions response — NO live vendor call (docs/TESTING.md rule 1). We assert
// (a) the adapter returns the model text, (b) the request it builds is correct
// (URL, model, auth header, system+user messages), (c) it fails loud on missing key /
// non-2xx / empty completion, and (d) the returned text parses end-to-end through the
// real consumers (extractUnderstanding + extractSubjectiveFeatures) into typed output.

import { describe, it, expect, vi } from "vitest";

import { createChatOpenAI, DEFAULT_CHAT_MODEL } from "../src/chat-openai";
import { extractUnderstanding } from "../src/understanding";
import { extractSubjectiveFeatures } from "../src/features";

/** Build a fake `fetch` that returns a canned OpenAI chat/completions body. */
function fakeFetch(content: string, init?: { ok?: boolean; status?: number; body?: unknown }) {
  const ok = init?.ok ?? true;
  const status = init?.status ?? 200;
  const payload =
    init?.body !== undefined
      ? init.body
      : { choices: [{ message: { role: "assistant", content } }] };
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return {
      ok,
      status,
      async json() {
        return payload;
      },
      async text() {
        return typeof payload === "string" ? payload : JSON.stringify(payload);
      },
    } as unknown as Response;
  });
}

const UNDERSTANDING_JSON = JSON.stringify({
  category: "Project management software",
  icp: "Software teams at startups",
  positioning: "The issue tracker built for high-velocity product teams.",
  whatYouAre: "Issue tracking for engineers\nBuilt for speed\nKeyboard-first UX\nLoved by startups",
});

const FEATURES_JSON = JSON.stringify({
  direct_answer_first: true,
  stats_density: 3.2,
  citation_density: 1,
  quote_density: 0,
  listicle_vs_prose: "prose",
});

describe("createChatOpenAI — request shape (fake fetch, no network)", () => {
  it("POSTs to /chat/completions with the model, auth header, and system+user messages", async () => {
    const fetchImpl = fakeFetch(UNDERSTANDING_JSON);
    const model = createChatOpenAI({ apiKey: "sk-test", fetchImpl });

    const out = await model.complete({ system: "SYS", user: "USER" });
    expect(out).toBe(UNDERSTANDING_JSON);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = fetchImpl.mock.calls[0][0] as string;
    const opts = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(opts.method).toBe("POST");
    expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect((opts.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body as string);
    expect(body.model).toBe(DEFAULT_CHAT_MODEL); // gpt-5-mini
    expect(body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USER" },
    ]);
    // gpt-5-mini only allows the default temperature — we must NOT send the field.
    expect(body).not.toHaveProperty("temperature");
  });

  it("honors a custom model / baseUrl and only sends temperature when explicitly set", async () => {
    const fetchImpl = fakeFetch(UNDERSTANDING_JSON);
    const model = createChatOpenAI({
      apiKey: "sk-test",
      fetchImpl,
      model: "gpt-4o-mini",
      baseUrl: "https://proxy.local/v1/",
      temperature: 0.2,
      maxCompletionTokens: 256,
    });
    await model.complete({ system: "S", user: "U" });

    const url = fetchImpl.mock.calls[0][0] as string;
    const opts = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(url).toBe("https://proxy.local/v1/chat/completions"); // trailing slash trimmed
    const body = JSON.parse(opts.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.temperature).toBe(0.2);
    expect(body.max_completion_tokens).toBe(256);
  });

  it("reads the key from process.env.OPENAI_API_KEY when no apiKey is injected", async () => {
    const fetchImpl = fakeFetch(UNDERSTANDING_JSON);
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-env";
    try {
      const model = createChatOpenAI({ fetchImpl });
      await model.complete({ system: "S", user: "U" });
      const opts = fetchImpl.mock.calls[0][1] as RequestInit;
      expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer sk-env");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});

describe("createChatOpenAI — fails loud", () => {
  it("throws when no API key is available (no live call attempted)", async () => {
    const fetchImpl = fakeFetch(UNDERSTANDING_JSON);
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const model = createChatOpenAI({ fetchImpl });
      await expect(model.complete({ system: "S", user: "U" })).rejects.toThrow(/api key|OPENAI_API_KEY/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = fakeFetch("", { ok: false, status: 429, body: "rate limited" });
    const model = createChatOpenAI({ apiKey: "sk-test", fetchImpl });
    await expect(model.complete({ system: "S", user: "U" })).rejects.toThrow(/429/);
  });

  it("throws on an empty completion", async () => {
    const fetchImpl = fakeFetch("", { body: { choices: [{ message: { content: "" } }] } });
    const model = createChatOpenAI({ apiKey: "sk-test", fetchImpl });
    await expect(model.complete({ system: "S", user: "U" })).rejects.toThrow(/empty/i);
  });
});

describe("createChatOpenAI — parses end-to-end through the real consumers", () => {
  it("feeds extractUnderstanding (canned understanding JSON -> typed understanding + card)", async () => {
    const fetchImpl = fakeFetch(UNDERSTANDING_JSON);
    const model = createChatOpenAI({ apiKey: "sk-test", fetchImpl });

    const result = await extractUnderstanding(model, {
      domain: "linear.app",
      name: "Linear",
      siteText: "Linear is a better way to build products.",
    });
    expect(result.understanding.category).toBe("Project management software");
    expect(result.understanding.icp).toBe("Software teams at startups");
    expect(result.whatYouAre.split("\n")).toHaveLength(4);
  });

  it("feeds extractSubjectiveFeatures (canned features JSON -> typed subjective vector)", async () => {
    const fetchImpl = fakeFetch(FEATURES_JSON);
    const model = createChatOpenAI({ apiKey: "sk-test", fetchImpl });

    const out = await extractSubjectiveFeatures(model, {
      url: "https://linear.app/features",
      text: "Some page text about issue tracking.",
    });
    expect(out).toEqual({
      direct_answer_first: true,
      stats_density: 3.2,
      citation_density: 1,
      quote_density: 0,
      listicle_vs_prose: 1, // "prose" -> 1
    });
  });

  it("tolerates code-fenced JSON returned by the model (consumer strips fences)", async () => {
    const fenced = "Sure!\n```json\n" + UNDERSTANDING_JSON + "\n```";
    const fetchImpl = fakeFetch(fenced);
    const model = createChatOpenAI({ apiKey: "sk-test", fetchImpl });
    const result = await extractUnderstanding(model, { domain: "linear.app", siteText: "x" });
    expect(result.understanding.category).toBe("Project management software");
  });
});
