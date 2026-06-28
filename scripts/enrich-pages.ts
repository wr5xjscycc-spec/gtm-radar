/**
 * Node edge runner: scrape a company's candidate pages via Orange Slice, enrich
 * them into contract-shaped `page` records, and write them to Convex.
 *
 * The Orange Slice SDK can't run inside a Convex V8 action, so the live scrape
 * stays here at the Node edge; the enriched `page` records are written back through
 * the sanctioned `api.records.upsertPage` mutation.
 *
 * Usage (print path — no Convex, no workspace needed; this is `npm run enrich:smoke`):
 *   npx tsx scripts/enrich-pages.ts <domain>
 *
 * Usage (write path — needs a REAL workspaces id; argv[3] takes precedence over env):
 *   CONVEX_URL=<deployment-url> WORKSPACE_ID=<workspaces-id> npx tsx scripts/enrich-pages.ts <domain>
 *   CONVEX_URL=<deployment-url> npx tsx scripts/enrich-pages.ts <domain> <workspaceId>
 *
 * Without CONVEX_URL the enriched records are printed as JSON for inspection.
 */
import { createOrangeSliceClient } from "../sourcing/src/orangeslice-client";
import { enrichPages } from "../sourcing/src/content";

async function main() {
  const domain = process.argv[2];
  if (!domain) {
    console.error(
      "Usage: [CONVEX_URL=… WORKSPACE_ID=…] npx tsx scripts/enrich-pages.ts <domain> [workspaceId]",
    );
    process.exit(1);
  }

  // Real workspaceId (a `workspaces` table id): argv[3] wins, else WORKSPACE_ID env.
  // Required only when writing to Convex (the print path doesn't need it).
  const workspaceId = process.argv[3] ?? process.env.WORKSPACE_ID;

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

  if (!workspaceId) {
    console.error(
      "CONVEX_URL is set but no workspaceId given. Pass a REAL workspaces id as " +
        "argv[3] or via WORKSPACE_ID=… — pages are scoped per workspace.",
    );
    process.exit(1);
  }

  // Write to Convex via ConvexHttpClient
  const { ConvexHttpClient } = await import("convex/browser");
  const { api } = await import("../convex/_generated/api");

  const c = new ConvexHttpClient(convexUrl);
  for (const page of pages) {
    await c.mutation(api.records.upsertPage, {
      workspaceId: workspaceId as any, // real workspaces id from argv[3] / WORKSPACE_ID
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
