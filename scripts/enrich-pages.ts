/**
 * Node edge runner — "send a website, it does everything."
 *
 * Give it ONE website. It scrapes that company's candidate pages via the Orange
 * Slice SDK, enriches them into contract-shaped `page` records, resolves (or
 * creates) the matching Convex workspace, and writes the pages back through the
 * sanctioned `api.records.upsertPage` mutation. Same shape as the orangeslice
 * CLI: one input in, the whole flow runs.
 *
 * The Orange Slice SDK can't run inside a Convex V8 action, so the live scrape
 * stays here at the Node edge; everything else is Convex.
 *
 * Auth/config resolve themselves:
 *   - Orange Slice key: the SDK reads ~/.config/orangeslice/config.json (set via
 *     `npx orangeslice login`) — no env juggling.
 *   - CONVEX_URL: read from the environment, else from ./.env.local.
 *
 * Usage:
 *   npx tsx scripts/enrich-pages.ts <website>            # does everything
 *   npm run enrich <website>
 *   npx tsx scripts/enrich-pages.ts <website> --measure  # also kick off the full
 *                                                        # battlefield + baseline
 *                                                        # measurement pipeline
 *   npx tsx scripts/enrich-pages.ts <website> --print    # print records, no write
 *
 * A specific workspace can be forced with WORKSPACE_ID=… (env) or as the 2nd arg;
 * otherwise the workspace whose own_domain matches the website is used, or a new
 * one is created from the website.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOrangeSliceClient } from "../sourcing/src/orangeslice-client";
import { enrichPages } from "../sourcing/src/content";
import { normalizeDomain } from "../sourcing/src/domain";

/** Read a single key out of ./.env.local without pulling in a dotenv dep. */
function fromEnvLocal(key: string): string | undefined {
  try {
    const text = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, "").trim();
    }
  } catch {
    /* no .env.local — fine */
  }
  return undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positionals = argv.filter((a) => !a.startsWith("--"));

  const website = positionals[0];
  if (!website) {
    console.error(
      "Usage: npx tsx scripts/enrich-pages.ts <website> [workspaceId] [--measure] [--print]",
    );
    process.exit(1);
  }

  const domain = normalizeDomain(website);
  if (!domain) {
    console.error(`"${website}" did not normalize to a domain key.`);
    process.exit(1);
  }

  const printOnly = flags.has("--print");
  const doMeasure = flags.has("--measure");
  const convexUrl = printOnly
    ? undefined
    : process.env.CONVEX_URL ?? fromEnvLocal("CONVEX_URL");

  const client = createOrangeSliceClient();
  const now = new Date().toISOString();

  console.error(`▸ Enriching ${domain}  (now=${now})`);
  const pages = await enrichPages(client, { companyDomain: domain, now });
  console.error(`  scraped + extracted ${pages.length} page(s)`);

  // ── Print path (smoke / no Convex) ─────────────────────────────────────────
  if (printOnly || !convexUrl) {
    console.log(JSON.stringify(pages, null, 2));
    console.error(
      `\n${pages.length} page record(s) printed${printOnly ? " (--print)" : " (no CONVEX_URL)"}.`,
    );
    return;
  }

  // ── Write path — resolve/create the workspace, then upsert pages ───────────
  const { ConvexHttpClient } = await import("convex/browser");
  const { api } = await import("../convex/_generated/api");
  const c = new ConvexHttpClient(convexUrl);

  // Workspace: explicit override → match-by-domain → create from the website.
  let workspaceId = (positionals[1] ?? process.env.WORKSPACE_ID) as
    | string
    | undefined;

  if (!workspaceId) {
    const existing = await c.query(api.customers.listWorkspaces, {});
    const match = existing.find((w: any) => w.own_domain === domain);
    if (match) {
      workspaceId = match._id;
      console.error(`  using workspace ${workspaceId} (${match.name})`);
    } else {
      workspaceId = (await c.mutation(api.customers.createWorkspace, {
        name: domain,
        vertical: "unknown",
        own_domain: domain,
        competitor_domains: [],
        measure_on_create: doMeasure,
      })) as string;
      console.error(
        `  created workspace ${workspaceId} for ${domain}` +
          (doMeasure ? " (battlefield + baseline measurement scheduled)" : ""),
      );
    }
  }

  for (const page of pages) {
    await c.mutation(api.records.upsertPage, {
      workspaceId: workspaceId as any,
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

  // For a pre-existing workspace, --measure still kicks off the full pipeline
  // (createWorkspace only auto-triggers it on creation).
  if (doMeasure && (positionals[1] || process.env.WORKSPACE_ID)) {
    await c.action(api.sourcing.buildBattlefield, {
      workspaceId: workspaceId as any,
      thenMeasure: true,
    });
    console.error("  scheduled battlefield + baseline measurement");
  }

  console.error(
    `\nDone — ${pages.length} page(s) upserted to workspace ${workspaceId}.`,
  );
}

main().catch((err) => {
  console.error("enrich-pages failed:", err);
  process.exit(1);
});
