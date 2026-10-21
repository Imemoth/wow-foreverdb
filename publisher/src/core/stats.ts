/** Observed-rate statistics. These are sample rates, never authoritative drop chances. */

export type Confidence = "insufficient" | "low" | "medium" | "high";

/** Wilson score interval (95%). Returns [lower, upper] in [0,1]. */
export function wilson(successes: number, trials: number, z = 1.959964): [number, number] {
  if (trials <= 0) return [0, 1];
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return [clamp01((centre - margin) / denom), clamp01((centre + margin) / denom)];
}

export function confidenceFor(
  observations: number,
  dominated: boolean,
  t: { minBucketObservationsForRate: number; lowConfidenceBelow: number; highConfidenceAtLeast: number },
): Confidence {
  if (observations < t.minBucketObservationsForRate) return "insufficient";
  let c: Confidence =
    observations < t.lowConfidenceBelow ? "low" : observations >= t.highConfidenceAtLeast ? "high" : "medium";
  // A sample dominated by one installation is never presented as high confidence.
  if (dominated && c === "high") c = "medium";
  return c;
}

/** Round to the precision allowed by numeric(7,6) to keep hashing stable. */
export function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
