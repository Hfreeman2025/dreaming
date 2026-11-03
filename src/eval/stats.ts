/**
 * The statistics behind `dreaming eval`. Small samples are the normal case
 * (30 runs at most), so every interval here is chosen for honest coverage at
 * small n rather than for convenience:
 *
 * - a pass rate gets the Clopper-Pearson exact interval (Clopper and Pearson
 *   1934), which never undercovers;
 * - the change in pass rate between the two arms gets Newcombe's hybrid score
 *   interval (Newcombe 1998, method 10), built from Wilson intervals, which
 *   behaves at 0/5 and 5/5 where the textbook Wald interval collapses;
 * - turns, tokens and time get a percentile bootstrap of the difference in
 *   means (Efron 1979), resampling within each task so that a heavy task
 *   cannot swamp a light one, with a seeded generator so a replay gives the
 *   same numbers.
 */

export interface Interval {
  low: number;
  high: number;
}

/** Continued fraction for the regularised incomplete beta function (Lentz's method). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= 300; m += 1) {
    const even = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + even * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + even / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    result *= d * c;
    const odd = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + odd * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + odd / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = d * c;
    result *= step;
    if (Math.abs(step - 1) < 1e-14) break;
  }
  return result;
}

/** ln Γ(x), Lanczos approximation (g = 7, n = 9); accurate to about 15 digits for x > 0. */
function logGamma(x: number): number {
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let sum = g[0] ?? 1;
  for (let i = 1; i < g.length; i += 1) sum += (g[i] ?? 0) / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** The regularised incomplete beta function I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  // The continued fraction converges fast on one side of the mean; use symmetry on the other.
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** The p-quantile of Beta(a, b), by bisection on the monotone CDF. */
export function betaQuantile(p: number, a: number, b: number): number {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 100; i += 1) {
    const mid = (low + high) / 2;
    if (incompleteBeta(mid, a, b) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Exact (Clopper-Pearson) interval for a binomial proportion: `successes` out of `n`. */
export function clopperPearson(successes: number, n: number, confidence = 0.95): Interval {
  if (n === 0) return { low: 0, high: 1 };
  const alpha = 1 - confidence;
  return {
    low: successes === 0 ? 0 : betaQuantile(alpha / 2, successes, n - successes + 1),
    high: successes === n ? 1 : betaQuantile(1 - alpha / 2, successes + 1, n - successes),
  };
}

const Z95 = 1.959963984540054;

/**
 * The standard normal quantile, by Acklam's rational approximation (relative
 * error below 1.2e-9): what z a two-sided interval at a given confidence needs.
 */
export function normalQuantile(p: number): number {
  // Horner's rule: coefficients from the highest power down.
  const poly = (coefficients: readonly number[], x: number) => coefficients.reduce((sum, c) => sum * x + c, 0);
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239,
  ];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572, 1];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416, 1];
  const tail = 0.02425;
  if (p < tail) {
    const q = Math.sqrt(-2 * Math.log(p));
    return poly(c, q) / poly(d, q);
  }
  if (p > 1 - tail) return -normalQuantile(1 - p);
  const q = p - 0.5;
  return (poly(a, q * q) * q) / poly(b, q * q);
}

/**
 * The z for intervals that hold together across `k` comparisons at 95%
 * (Bonferroni, as in Dunn 1961): each interval at 1 − 0.05/k.
 */
export const simultaneousZ = (k: number): number => normalQuantile(1 - 0.05 / (2 * Math.max(1, k)));

/** Wilson score interval for a proportion. */
export function wilson(successes: number, n: number, z = Z95): Interval {
  if (n === 0) return { low: 0, high: 1 };
  const p = successes / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const denominator = 1 + (z * z) / n;
  return { low: (centre - spread) / denominator, high: (centre + spread) / denominator };
}

/**
 * Newcombe's hybrid score interval for p2 − p1, two independent proportions.
 * Each run is an independent sample, so the arms are independent; runs are
 * not paired across arms.
 */
export function newcombeDifference(
  s1: number,
  n1: number,
  s2: number,
  n2: number,
  z = Z95,
): Interval & { estimate: number } {
  const p1 = n1 === 0 ? 0 : s1 / n1;
  const p2 = n2 === 0 ? 0 : s2 / n2;
  const w1 = wilson(s1, n1, z);
  const w2 = wilson(s2, n2, z);
  const estimate = p2 - p1;
  return {
    estimate,
    low: estimate - Math.sqrt((p2 - w2.low) ** 2 + (w1.high - p1) ** 2),
    high: estimate + Math.sqrt((w2.high - p2) ** 2 + (p1 - w1.low) ** 2),
  };
}

/** A small, fast, seedable generator (mulberry32); good enough for resampling. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shuffle a copy of `items` with a seeded Fisher-Yates. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const random = seededRandom(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

const mean = (values: readonly number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

export interface Stratum {
  without: readonly number[];
  with: readonly number[];
}

/**
 * Difference in means (with − without) over strata (tasks), with a percentile
 * bootstrap interval. Each resample draws, within every stratum, as many values
 * with replacement as that stratum has in each arm; the statistic is the
 * difference of the pooled means. Strata with fewer than two runs in either arm are left out.
 */
export function bootstrapDifference(
  strata: readonly Stratum[],
  options: { seed: number; resamples?: number; confidence?: number },
): (Interval & { estimate: number; without: number; with: number }) | null {
  // A stratum with one run in an arm resamples to itself and fakes certainty, so it waits for a second.
  const usable = strata.filter((s) => s.without.length >= 2 && s.with.length >= 2);
  if (usable.length === 0) return null;
  const pooled = (pick: (s: Stratum) => readonly number[]) => mean(usable.flatMap(pick));
  const without = pooled((s) => s.without);
  const withMemory = pooled((s) => s.with);
  const random = seededRandom(options.seed);
  const draw = (values: readonly number[]) =>
    Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)] ?? 0);
  const resamples = options.resamples ?? 10_000;
  const differences: number[] = [];
  for (let i = 0; i < resamples; i += 1) {
    const a: number[] = [];
    const b: number[] = [];
    for (const stratum of usable) {
      a.push(...draw(stratum.without));
      b.push(...draw(stratum.with));
    }
    differences.push(mean(b) - mean(a));
  }
  differences.sort((x, y) => x - y);
  const alpha = 1 - (options.confidence ?? 0.95);
  const at = (q: number) =>
    differences[Math.min(differences.length - 1, Math.max(0, Math.floor(q * differences.length)))] ?? 0;
  return { estimate: withMemory - without, without, with: withMemory, low: at(alpha / 2), high: at(1 - alpha / 2) };
}

/** Two-sided Fisher exact test p-value for a 2×2 table (a passes / b fails without; c passes / d fails with). */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const logFactorial = (n: number) => logGamma(n + 1);
  const n = a + b + c + d;
  const row1 = a + b;
  const col1 = a + c;
  const probability = (x: number) =>
    Math.exp(
      logFactorial(row1) +
        logFactorial(n - row1) +
        logFactorial(col1) +
        logFactorial(n - col1) -
        logFactorial(n) -
        logFactorial(x) -
        logFactorial(row1 - x) -
        logFactorial(col1 - x) -
        logFactorial(n - row1 - col1 + x),
    );
  const observed = probability(a);
  let p = 0;
  for (let x = Math.max(0, row1 + col1 - n); x <= Math.min(row1, col1); x += 1) {
    const px = probability(x);
    if (px <= observed * (1 + 1e-7)) p += px;
  }
  return Math.min(1, p);
}
