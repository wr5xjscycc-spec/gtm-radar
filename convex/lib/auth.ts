/**
 * Workspace scoping helpers (owner: P1).
 *
 * Every record is owned by a workspace; every read/write is scoped to the
 * caller's workspace. Convex Auth provides the caller identity via
 * `ctx.auth.getUserIdentity()` (configured in ../auth.config.ts). During Phase-0
 * bring-up (before the auth provider is wired in a deployment) these helpers
 * degrade gracefully: an unauthenticated caller gets `owner: undefined` rather
 * than a hard failure, so teammates can exercise the data layer immediately.
 * Flip `REQUIRE_AUTH` to true once the provider is live to enforce ownership.
 */
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

const REQUIRE_AUTH = false; // set true once auth.config.ts provider is deployed

/** The authenticated owner subject, or undefined when auth isn't wired yet. */
export async function getOwner(
  ctx: QueryCtx | MutationCtx,
): Promise<string | undefined> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    if (REQUIRE_AUTH) throw new Error("Unauthenticated");
    return undefined;
  }
  return identity.subject;
}

/**
 * Load a workspace and assert the caller owns it (when auth is enforced).
 * Returns the workspace doc. Use in every workspace-scoped mutation/query.
 */
export async function requireWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
) {
  const ws = await ctx.db.get(workspaceId);
  if (!ws) throw new Error("Workspace not found");
  if (REQUIRE_AUTH) {
    const owner = await getOwner(ctx);
    if (ws.owner && ws.owner !== owner) {
      throw new Error("Forbidden: workspace belongs to another owner");
    }
  }
  return ws;
}
