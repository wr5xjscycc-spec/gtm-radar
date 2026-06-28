/**
 * Node edge runner: scrape a company's candidate pages via Orange Slice, enrich
 * them into contract-shaped `page` records, and write them to Convex.
 *
 * Usage:
 *   CONVEX_URL=<deployment-url> npx tsx scripts/enrich-pages.ts <domain>
 *
 * Without CONVEX_URL the enriched records are printed as JSON for inspection.
 */
import { createOrangeSliceClient } from "../sourcing/src/orangeslice-client";
import { enrichPages } from "../sourcing/src/content";

async function main() {
  const domain = process.argv[2];
  if (!domain) {
    console.error("Usage: CONVEX_URL=… npx tsx scripts/enrich-pages.ts <domain>");
    process.exit(1);
  }

  const client = createOrangeSliceClient();
  const now = new Date().toISOString();

  console.error(`Scraping & enriching pages for domain: ${domain}  (now=${now})`);
  const pages = await enrichPages(client, { companyDomain: domain, now });

  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    // No Convex target — print records as JSON for inspection
    console.log(JSON.stringify(pages, null, 2));
    console.error(`\n${pages.length} page records printed (no CONVEX_URL set).`);
    return;
  }

  // Write to Convex via ConvexHttpClient
  const { ConvexHttpClient } = await import("convex/browser");
  const { api } = await import("../convex/_generated/api");

  const c = new ConvexHttpClient(convexUrl);
  for (const page of pages) {
    await c.mutation(api.records.upsertPage, {
      workspaceId: page.company_domain as any, // placeholder — real workspaceId TBD
      company_domain: page.company_domain,
      url: page.url,
      role: page.role,
      content_features: page.content_features,
      extractor_version: page.extractor_version,
      scraped_at: page.scraped_at,
      cache_key: page.cache_key,
    });
    console.error(`  upserted: ${page.url}`);
  }

  console.error(`\nDone — ${pages.length} pages upserted.`);
}

main().catch((err) => {
  console.error("enrich-pages failed:", err);
  process.exit(1);
});
