/**
 * Convex Auth configuration (owner: P1) — Phase-0 scaffold.
 *
 * Declares the JWT issuer(s) Convex trusts so `ctx.auth.getUserIdentity()`
 * resolves a caller. The provider domain/appId come from env (never hardcoded,
 * never client-exposed). Wire a real provider (Convex Auth / Clerk / Auth0) in a
 * deployment, then flip REQUIRE_AUTH in ./lib/auth.ts to enforce ownership.
 *
 * Set in the deployment, not in the repo:
 *   npx convex env set AUTH_ISSUER_DOMAIN <issuer-url>
 *   npx convex env set AUTH_APP_ID <application-id>
 */
// Phase-0: no provider wired yet. Wire a real issuer (Convex Auth / Clerk /
// Auth0) here and set AUTH_ISSUER_DOMAIN + AUTH_APP_ID in the Convex deployment
// env before enabling REQUIRE_AUTH in ./lib/auth.ts.
export default {
  providers: [],
};
