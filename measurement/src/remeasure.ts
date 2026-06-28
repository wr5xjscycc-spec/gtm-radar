import type { EngineAdapter, EngineName } from "./engine";
import { adaptiveSample, type AdaptiveSampleConfig, DEFAULT_ADAPTIVE_CONFIG } from "./sampler";
import { type RunRecord, type AggregateResult, aggregateRuns } from "./aggregate";
import { normalizeUrl, normalizeDomain } from "../../convex/lib/domain";

export type WindowTag = "baseline" | "post";
export type ExperimentArm = "treatment" | "control";

export interface ExperimentPage {
  page_url: string;
  company_domain: string;
}

export interface ExperimentPagePair {
  treatment_page: ExperimentPage;
  control_page: ExperimentPage;
}

export interface Experiment {
  id: string;
  customer_id: string;
  pairs: ExperimentPagePair[];
}

export interface RemeasureOptions {
  experiment: Experiment;
  windowTag: WindowTag;
  queryId: string;
  queryText: string;
  engine: EngineName;
  adapter: EngineAdapter;
  adaptiveConfig?: AdaptiveSampleConfig;
}

export interface ArmInfo {
  treatment: {
    pageCount: number;
    runCount: number;
  };
  control: {
    pageCount: number;
    runCount: number;
  };
}

export interface RemeasureResult {
  runs: RunRecord[];
  aggregates: AggregateResult[];
  arms: ArmInfo;
  model_version: string;
}

/**
 * Re-measure an experiment's pages with window tagging and identical-arm protocol.
 *
 * EVERY page in the experiment (treatment + control) is measured with:
 *   - The SAME engine adapter
 *   - The SAME adaptive sample config
 *   - The SAME query text
 *
 * This enforces the identical-arm protocol: any asymmetry between treatment
 * and control measurement biases the DiD estimate.
 *
 * All produced rows are stamped with:
 *   - window_tag: "baseline" | "post"  (specified by caller)
 *   - experiment_id: the experiment's id
 */
export async function remeasureExperiment(
  options: RemeasureOptions,
): Promise<RemeasureResult> {
  const {
    experiment,
    windowTag,
    queryId,
    queryText,
    engine,
    adapter,
    adaptiveConfig = DEFAULT_ADAPTIVE_CONFIG,
  } = options;

  const allRuns: RunRecord[] = [];
  const allAggregates: AggregateResult[] = [];
  let treatmentRunCount = 0;
  let controlRunCount = 0;

  for (const pair of experiment.pairs) {
    const pages: Array<{ page: ExperimentPage; arm: ExperimentArm }> = [
      { page: pair.treatment_page, arm: "treatment" },
      { page: pair.control_page, arm: "control" },
    ];

    for (const { page, arm } of pages) {
      const sampleResult = await adaptiveSample(
        queryId,
        queryText,
        page.company_domain,
        page.page_url,
        engine,
        adapter,
        adaptiveConfig,
      );

      const stampedRuns = sampleResult.runs.map((r) => ({
        ...r,
        window_tag: windowTag as RunRecord["window_tag"],
        experiment_id: experiment.id,
      }));

      const stampedAggregate = aggregateRuns(
        queryId,
        normalizeUrl(page.page_url),
        normalizeDomain(page.company_domain),
        engine,
        stampedRuns,
      );

      allRuns.push(...stampedRuns);
      allAggregates.push(stampedAggregate);

      if (arm === "treatment") {
        treatmentRunCount += stampedRuns.length;
      } else {
        controlRunCount += stampedRuns.length;
      }
    }
  }

  const modelVersion =
    allRuns.length > 0 ? allRuns[0].model_version : "unknown";

  return {
    runs: allRuns,
    aggregates: allAggregates,
    arms: {
      treatment: { pageCount: experiment.pairs.length, runCount: treatmentRunCount },
      control: { pageCount: experiment.pairs.length, runCount: controlRunCount },
    },
    model_version: modelVersion,
  };
}
