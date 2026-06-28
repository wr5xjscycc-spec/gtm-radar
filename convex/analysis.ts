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
      // Guard the downstream poll path: never interpolate an unvalidated
      // service-supplied id into a URL (path-traversal / SSRF hardening).
      if (!/^[A-Za-z0-9_-]+$/.test(fitJob.job_id ?? "")) {
        throw new Error(`service returned an invalid job_id: ${JSON.stringify(fitJob.job_id)}`);
      }
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
        const pollRes = await fetch(`${baseUrl}/fit/${encodeURIComponent(serviceJobId)}`);
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

/**
 * runLift — Convex → Python difference-in-differences round-trip (the causal layer).
 *
 * Mirrors {@link runFit}: POSTs a lift request to the Python analysis service's
 * ``/estimate-lift`` endpoint, polls until the async job completes, and writes the
 * result as a ``lift_result`` record via the sanctioned mutation
 * (``api.records.insertLiftResult``). A ``lift_result`` is the ONLY record allowed to
 * carry causal (claim_rung=2) language — it is earned solely from this randomized
 * matched-pair DiD path, never from observational ``model_fit`` coefficients.
 *
 * The same SSRF hardening as runFit applies: the service-supplied ``job_id`` is
 * validated against ``^[A-Za-z0-9_-]+$`` and ``encodeURIComponent``-escaped before it
 * is ever interpolated into the poll URL.
 *
 * Required env config: ANALYSIS_SERVICE_URL (default http://localhost:8000).
 */
export const runLift = action({
  args: {
    workspaceId: v.id("workspaces"),
    experiment_id: v.id("experiments"),
    experiment: v.object({
      id: v.string(),
      customer_id: v.string(),
      pairs: v.array(
        v.object({
          treatment_page: v.string(),
          control_page: v.string(),
          match_covars: v.optional(
            v.record(v.string(), v.union(v.number(), v.string())),
          ),
        }),
      ),
      baseline_window: v.string(),
      post_window: v.string(),
      status: v.optional(v.string()),
      publish_event_ts: v.optional(v.string()),
    }),
    // Windowed (baseline + post) measurement rows for the experiment's pages.
    // Passed through as-is to the DiD estimator (it filters by engine + page itself).
    measurements: v.array(v.any()),
    engine: v.optional(engine),
    computed_at: v.optional(v.string()),
    lift_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const baseUrl = process.env.ANALYSIS_SERVICE_URL || "http://localhost:8000";

    // Capture one timestamp: send its ISO form to the service (echoed onto the
    // LiftResult), persist its numeric form to the DB (the schema wants a number).
    const now = Date.now();
    const computedAtIso = new Date(now).toISOString();

    const liftRequest = {
      experiment: {
        id: args.experiment.id,
        customer_id: args.experiment.customer_id,
        pairs: args.experiment.pairs.map((p) => ({
          treatment_page: p.treatment_page,
          control_page: p.control_page,
          ...(p.match_covars !== undefined
            ? { match_covars: p.match_covars }
            : {}),
        })),
        baseline_window: args.experiment.baseline_window,
        post_window: args.experiment.post_window,
        ...(args.experiment.status !== undefined
          ? { status: args.experiment.status }
          : {}),
        ...(args.experiment.publish_event_ts !== undefined
          ? { publish_event_ts: args.experiment.publish_event_ts }
          : {}),
      },
      measurements: args.measurements,
      engine: args.engine ?? "openai",
      computed_at: args.computed_at ?? computedAtIso,
      lift_id: args.lift_id ?? `lift_${now}`,
    };

    // 1) POST the lift request to the Python service.
    let serviceJobId: string;
    try {
      const res = await fetch(`${baseUrl}/estimate-lift`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(liftRequest),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`POST /estimate-lift returned ${res.status}: ${body}`);
      }
      const liftJob: { job_id: string; status: string } = await res.json();
      // Guard the downstream poll path: never interpolate an unvalidated
      // service-supplied id into a URL (path-traversal / SSRF hardening).
      if (!/^[A-Za-z0-9_-]+$/.test(liftJob.job_id ?? "")) {
        throw new Error(
          `service returned an invalid job_id: ${JSON.stringify(liftJob.job_id)}`,
        );
      }
      serviceJobId = liftJob.job_id;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`lift submit failed: ${msg}`);
    }

    // 2) Poll until the job is complete or failed.
    const pollDelayMs = 2000;
    const maxPolls = 150; // 5 min
    let result: unknown = null;
    let pollError: string | undefined;
    let completed = false;

    for (let i = 0; i < maxPolls; i++) {
      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
      try {
        const pollRes = await fetch(
          `${baseUrl}/estimate-lift/${encodeURIComponent(serviceJobId)}`,
        );
        if (!pollRes.ok) {
          const body = await pollRes.text();
          throw new Error(
            `GET /estimate-lift/${serviceJobId} returned ${pollRes.status}: ${body}`,
          );
        }
        const job: { status: string; result?: unknown; error?: string } =
          await pollRes.json();

        if (job.status === "complete") {
          result = job.result ?? null;
          completed = true;
          break;
        }
        if (job.status === "failed") {
          pollError = job.error ?? "lift job failed without an error message";
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
      pollError = "lift job did not complete within the polling timeout";
    }
    if (pollError) {
      throw new Error(pollError);
    }

    // 3) Write the lift_result record.
    const lr = result as {
      id?: string;
      experiment_id: string;
      estimate: number;
      ci_low: number;
      ci_high: number;
      p_value?: number | null;
      verdict: "worked" | "no_effect" | "inconclusive";
      claim_rung?: number;
      computed_at: string;
    };

    await ctx.runMutation(api.records.insertLiftResult, {
      workspaceId: args.workspaceId,
      // Use the Convex experiment id, never the Python-echoed experiment.id.
      experiment_id: args.experiment_id,
      estimate: lr.estimate,
      ci_low: lr.ci_low,
      ci_high: lr.ci_high,
      // p_value is Optional on the LiftResult (null at degenerate N) but the record
      // requires a number; 1.0 == "no significance" is the honest fill for null.
      p_value: lr.p_value ?? 1.0,
      verdict: lr.verdict,
      claim_rung: lr.claim_rung ?? 2,
      // Persist the numeric timestamp (schema wants a number, not the ISO string).
      computed_at: now,
    });

    return {
      jobId: serviceJobId,
      liftId: lr.id ?? null,
      verdict: lr.verdict,
    };
  },
});
