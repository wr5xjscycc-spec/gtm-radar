// Orange Slice real client — thin adapter wrapping the orangeslice SDK.
//
// The SDK provides services.web.search (SERP) + services.scrape.website (markdown
// scrape). This adapter maps them to the OrangeSliceClient port so the content
// enrichment pipeline (content.ts → enrichPages) runs against the real vendor.
//
// Per docs/TESTING.md the network call is NEVER made in tests: callers inject a
// fake `services` object. CI stays deterministic and free.

import { services as realServices, configure } from "orangeslice";
import type { OrangeSliceClient, OrangeSlicePage } from "./content";

export interface CreateOrangeSliceClientOpts {
  /** API key (optional — auth chain: configure() > env > config file). */
  apiKey?: string;
  /** Max pages to scrape per domain (default 10). */
  perDomainLimit?: number;
}

/**
 * Create a real OrangeSlice-backed client.
 *
 * @param opts      Optional apiKey / perDomainLimit overrides.
 * @param svc       INJECTED services object (defaults to the real orangeslice
 *                  SDK). Tests pass a fake; production omits it.
 */
export function createOrangeSliceClient(
  opts?: CreateOrangeSliceClientOpts,
  svc: { web: { search: typeof realServices.web.search }; scrape: { website: typeof realServices.scrape.website } } = realServices,
): OrangeSliceClient {
  const limit = opts?.perDomainLimit ?? 10;
  let configured = false;

  return {
    async scrapeCandidatePages({ domain, limit: domainLimit }) {
      if (!configured && opts?.apiKey) {
        configure({ apiKey: opts.apiKey });
        configured = true;
      }

      const cap = domainLimit ?? limit;

      // 1. Search for candidate URLs
      let links: string[];
      try {
        const searchResult = await svc.web.search({ query: `site:${domain}` });
        links = (searchResult.results ?? []).slice(0, cap).map((r) => r.link);
      } catch {
        return [];
      }

      // 2. Scrape each URL — per-URL tolerance
      const pages: OrangeSlicePage[] = [];
      for (const url of links) {
        try {
          const scraped = await svc.scrape.website({ url });
          const markdown = scraped.markdown
            ?? scraped.data?.[0]?.markdown
            ?? "";
          if (!markdown) continue;

          pages.push({
            url,
            html: markdown,
            text: markdown,
            role: "candidate",
          });
        } catch {
          continue;
        }
      }

      return pages;
    },
  };
}
