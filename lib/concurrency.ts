/**
 * Runs `fn` over every item in `items`, with at most `limit` running at
 * once. Unlike a plain sequential loop, this matters a lot here:
 * Vercel serverless functions have a hard wall-clock time limit per
 * request, and a 20-30 card bulk scan doing everything one card at a
 * time (each needing a Gemini call, a crop, another Gemini call, and a
 * storage POST) would very likely blow past it. Running several cards
 * concurrently cuts total wall-clock time roughly by the concurrency
 * factor, since each card's work is I/O-bound (network calls), not
 * CPU-bound.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
