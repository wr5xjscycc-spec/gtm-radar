import { normalizeDomain } from "../../convex/lib/domain";

export const ENGINE_NAMES = ["openai", "perplexity", "gemini"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

export interface EngineResult {
  engine: EngineName;
  appeared: boolean;
  cited: boolean;
  position: number | null;
  source_urls: string[];
  model_version: string;
}

export interface MeasureOptions {
  targetDomain: string;
}

export interface EngineAdapter {
  measure(queryText: string, options: MeasureOptions): Promise<EngineResult>;
}

export function computeCitationResult(
  engine: EngineName,
  sourceUrls: string[],
  targetDomain: string,
  modelVersion: string,
): EngineResult {
  const citedDomains = sourceUrls.map((u) => normalizeDomain(u));
  const normalizedTarget = normalizeDomain(targetDomain);
  const matchedIdx = citedDomains.indexOf(normalizedTarget);
  const cited = matchedIdx !== -1;

  return {
    engine,
    appeared: sourceUrls.length > 0,
    cited,
    position: cited ? matchedIdx : null,
    source_urls: sourceUrls,
    model_version: modelVersion,
  };
}
