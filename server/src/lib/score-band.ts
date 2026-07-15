/** Bucket a 0–100 score into a band. */
export function scoreBand(score: number): 'low' | 'mid' | 'high' {
  if (score < 40) return 'low';
  if (score < 80) return 'mid';
  return 'high';
}
