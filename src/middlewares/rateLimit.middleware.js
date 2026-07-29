const ApiError = require("../utils/apiError");

const buckets = new Map();

const rateLimit = ({ keyPrefix = "api", limit = 120, windowMs = 60_000 } = {}) => (req, res, next) => {
  const now = Date.now();
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const identity = forwarded || req.ip || req.socket?.remoteAddress || "unknown";
  const key = `${keyPrefix}:${identity}`;
  const current = buckets.get(key);
  const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
  bucket.count += 1;
  buckets.set(key, bucket);

  res.setHeader("RateLimit-Limit", limit);
  res.setHeader("RateLimit-Remaining", Math.max(0, limit - bucket.count));
  res.setHeader("RateLimit-Reset", Math.ceil(bucket.resetAt / 1000));

  if (bucket.count > limit) {
    res.setHeader("Retry-After", Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
    return next(new ApiError(429, "Too many requests. Please wait briefly and try again."));
  }

  if (buckets.size > 10_000) {
    for (const [bucketKey, value] of buckets) {
      if (value.resetAt <= now) buckets.delete(bucketKey);
    }
  }
  return next();
};

module.exports = { rateLimit };
