/**
 * Upper bounds of the latency buckets, in milliseconds. The last bucket holds everything slower.
 * Buckets, unlike percentiles, can be summed across reports and processes by the dashboard.
 * Keep in sync with the dashboard.
 */
export const LATENCY_BUCKETS_MS: readonly number[] = [
	50, 100, 250, 500, 1000, 2000, 3000, 5000, 10000,
];

export function emptyBuckets(): number[] {
	return Array.from({ length: LATENCY_BUCKETS_MS.length + 1 }, () => 0);
}

export function bucketIndex(ms: number): number {
	const index = LATENCY_BUCKETS_MS.findIndex((bound) => ms <= bound);

	return index === -1 ? LATENCY_BUCKETS_MS.length : index;
}
