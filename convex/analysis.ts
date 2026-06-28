/**
 * Analysis action — Convex → Python fit-job round-trip.
 *
 * Accepts a fit request via action args, POSTs it to the Python analysis service
 * (FastAPI), polls until the job is complete, and writes the result as a
 * ``model_fit`` record via the sanctioned mutation (``api.records.insertModelFit``).
 *
 * This is the ONLY place external I/O for analysis happens (the Python service
 * call). Every fit job is tracked in the ``analysis_jobs`` table so ops can
 * observe progress and diagnose failures.
 *
 * Required env config (set via ``npx convex env set``):
 *   ANALYSIS_SERVICE_URL   default http://localhost:8000
 */
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";

const engine = v.union(
  v.literal("openai"),
  v.literal("perplexity"),
  v.literal("gemini"),
);

export const runFit = action({
  args: {
    workspaceId: v.id("workspaces"),
    customer_id: v.id("workspaces"),
    category: v.string(),
    engine,
    prior_version: v.optional(v.string()),
    rows: v.array(
      v.object({
        page_url: v.string(),
        company_domain: v.string(),
        p_cited: v.number(),
        ci_width: v.optional(v.number()),
        label: v.optional(v.string()),
        features: v.optional(v.record(v.string(), v.number())),
      }),
    ),
    features: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const baseUrl = process.env.ANALYSIS_SERVICE_URL || "http://localhost:8000";

    const customerId = args.customer_id.toString();
    const fitRequest = {
      customer_id: customerId,
      category: args.category,
      engine: args.engine,
      prior_version: args.prior_version ?? "phase0-dummy-v0",
      rows: args.rows.map((r) => ({
        page_url: r.page_url,
        company_domain: r.company_domain,
        p_cited: r.p_cited,
        ...(r.ci_width !== undefined ? { ci_width: r.ci_width } : {}),
        ...(r.label !== undefined ? { label: r.label } : {}),
        ...(r.features !== undefined ? { features: r.features } : {}),
      })),
      ...(args.features !== undefined ? { features: args.features } : {}),
    };

    // 1) Create an analysis_jobs record.
    const now = Date.now();
    const jobId = await ctx.runMutation(api.analysisJobs.insertJob, {
      workspaceId: args.workspaceId,
      customer_id: customerId,
      category: args.category,
      engine: args.engine,
      request: JSON.stringify(fitRequest),
      job_id: "",
      status: "queued",
      created_at: now,
      updated_at: now,
    });

    // 2) POST the fit request to the Python service.
    let serviceJobId: string;
    try {
      const res = await fetch(`${baseUrl}/fit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fitRequest),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`POST /fit returned ${res.status}: ${body}`);
      }
      const fitJob: { job_id: string; status: string } = await res.json();
      serviceJobId = fitJob.job_id;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(api.analysisJobs.updateJob, {
        jobId,
        status: "failed",
        error: msg,
        updated_at: Date.now(),
      });
      throw new Error(`fit submit failed: ${msg}`);
    }

    // 3) Update the job record with the service job_id and set status to running.
    await ctx.runMutation(api.analysisJobs.updateJob, {
      jobId,
      status: "running",
      job_id: serviceJobId,
      updated_at: Date.now(),
    });

    // 4) Poll until the job is complete or failed.
    const pollDelayMs = 2000;
    const maxPolls = 150; // 5 min
    let result: unknown = null;
    let pollError: string | undefined;
    let completed = false;

    for (let i = 0; i < maxPolls; i++) {
      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
      try {
        const pollRes = await fetch(`${baseUrl}/fit/${serviceJobId}`);
        if (!pollRes.ok) {
          const body = await pollRes.text();
          throw new Error(`GET /fit/${serviceJobId} returned ${pollRes.status}: ${body}`);
        }
        const job: {
          status: string;
          result?: unknown;
          error?: string;
        } = await pollRes.json();

        if (job.status === "complete") {
          result = job.result ?? null;
          completed = true;
          break;
        }
        if (job.status === "failed") {
          pollError = job.error ?? "fit job failed without an error message";
          completed = true;
          break;
        }
        // still queued / running — keep polling
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        pollError = `poll error: ${msg}`;
        completed = true;
        break;
      }
    }

    if (!completed) {
      pollError = "fit job did not complete within the polling timeout";
    }

    if (pollError) {
      await ctx.runMutation(api.analysisJobs.updateJob, {
        jobId,
        status: "failed",
        error: pollError,
        updated_at: Date.now(),
      });
      throw new Error(pollError);
    }

    // 5) Write the model_fit record.
    const mf = result as {
      id?: string;
      customer_id: string;
      category: string;
      engine: string;
      coefficients: Array<{
        feature: string;
        posterior_median: number;
        ci_low: number;
        ci_high: number;
        noise_flag: boolean;
      }>;
      prior_version: string;
      top_hypotheses?: string[];
      n_companies: number;
      n_rows: number;
    };

    await ctx.runMutation(api.records.insertModelFit, {
      workspaceId: args.workspaceId,
      customer_id: args.customer_id,
      category: mf.category,
      engine: mf.engine as any,
      coefficients: mf.coefficients,
      prior_version: mf.prior_version,
      top_hypotheses: mf.top_hypotheses ?? [],
      n_companies: mf.n_companies,
      n_rows: mf.n_rows,
    });

    // 6) Mark the job complete.
    await ctx.runMutation(api.analysisJobs.updateJob, {
      jobId,
      status: "complete",
      result: JSON.stringify(result),
      updated_at: Date.now(),
    });

    return { jobId: serviceJobId, fitId: mf.id ?? null };
  },
});
