/**
 * Ambient declaration for `process.env` inside Convex functions.
 *
 * Convex actions can read environment variables (set via `npx convex env set`)
 * through `process.env` at runtime, but the Convex tsconfig deliberately omits
 * `@types/node` to keep the function global scope minimal. This narrow shim makes
 * `process.env.FOO` typecheck without pulling all of Node's globals into scope.
 */
declare const process: {
  env: Record<string, string | undefined>;
};
