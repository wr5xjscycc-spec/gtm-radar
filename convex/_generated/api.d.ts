/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as analysis from "../analysis.js";
import type * as analysisJobs from "../analysisJobs.js";
import type * as asset from "../asset.js";
import type * as board from "../board.js";
import type * as crons from "../crons.js";
import type * as customers from "../customers.js";
import type * as devSeed from "../devSeed.js";
import type * as diagnose from "../diagnose.js";
import type * as experiments from "../experiments.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_compliance from "../lib/compliance.js";
import type * as lib_domain from "../lib/domain.js";
import type * as measure from "../measure.js";
import type * as moat from "../moat.js";
import type * as records from "../records.js";
import type * as sourcing from "../sourcing.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  analysis: typeof analysis;
  analysisJobs: typeof analysisJobs;
  asset: typeof asset;
  board: typeof board;
  crons: typeof crons;
  customers: typeof customers;
  devSeed: typeof devSeed;
  diagnose: typeof diagnose;
  experiments: typeof experiments;
  "lib/auth": typeof lib_auth;
  "lib/compliance": typeof lib_compliance;
  "lib/domain": typeof lib_domain;
  measure: typeof measure;
  moat: typeof moat;
  records: typeof records;
  sourcing: typeof sourcing;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
