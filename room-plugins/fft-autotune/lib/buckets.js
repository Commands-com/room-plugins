import { isPowerOfTwo, resolveBucketKey } from './utils.js';

export function getExpectedBucketKeys(config) {
  return config.targetSizes
    .filter(isPowerOfTwo)
    .map((size) => resolveBucketKey(size, config));
}

export function getMissingBaselineBucketKeys(state, config) {
  const covered = new Set(
    Object.keys(state.baselines || {}).filter((bucketKey) => Number.isFinite(state.baselines[bucketKey]?.medianNs)),
  );
  return getExpectedBucketKeys(config).filter((bucketKey) => !covered.has(bucketKey));
}

export function getMissingWinnerBucketKeys(state, config) {
  const winnerBuckets = new Set(
    Object.keys(state.bestByBucket || {}).filter((bucketKey) => Boolean(state.bestByBucket[bucketKey])),
  );
  return getExpectedBucketKeys(config).filter((bucketKey) => !winnerBuckets.has(bucketKey));
}
