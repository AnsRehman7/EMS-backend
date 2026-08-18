const { Redis } = require("@upstash/redis");
const prisma = require("../db/prisma");
const { env } = require("../config/env");

/**
 * Storage for one-time sign-in codes.
 *
 * Upstash is used when configured: it speaks HTTP, so it works on serverless where a
 * pooled TCP client would not, and its native TTLs expire codes without a cleanup job.
 * When it is not configured the store falls back to the `login_otps` table so local
 * development and a Redis outage both keep working.
 *
 * Only an HMAC of the code is ever written to either backend.
 */
const HOUR_SECONDS = 60 * 60;

const redisEnabled = Boolean(env.redisUrl && env.redisToken);

let redisClient = null;
const redis = () => {
  if (!redisEnabled) return null;
  if (!redisClient) {
    redisClient = new Redis({ token: env.redisToken, url: env.redisUrl });
  }
  return redisClient;
};

const codeKey = (email) => `otp:code:${email}`;
const attemptsKey = (email) => `otp:attempts:${email}`;
const cooldownKey = (email) => `otp:cooldown:${email}`;
const hourlyKey = (email) => `otp:hourly:${email}`;

/* -------------------------------------------------------------------------- */
/* Redis backend                                                              */
/* -------------------------------------------------------------------------- */

const redisStore = {
  /**
   * Claims the resend slot. `SET NX EX` makes the check-and-set atomic, so two
   * concurrent requests cannot both pass the cooldown.
   */
  async claimRequestSlot(email, { cooldownSeconds, maxPerHour }) {
    const client = redis();
    const reserved = await client.set(cooldownKey(email), "1", { ex: cooldownSeconds, nx: true });

    if (reserved !== "OK") {
      const ttl = await client.ttl(cooldownKey(email));
      return { allowed: false, reason: "cooldown", waitSeconds: Math.max(1, ttl) };
    }

    const hourly = await client.incr(hourlyKey(email));
    if (hourly === 1) await client.expire(hourlyKey(email), HOUR_SECONDS);

    if (hourly > maxPerHour) return { allowed: false, reason: "hourly" };

    return { allowed: true };
  },

  async saveCode(email, { codeHash, ttlSeconds }) {
    const client = redis();
    // Replaces any outstanding code for this address and resets its attempt counter.
    await Promise.all([
      client.set(codeKey(email), codeHash, { ex: ttlSeconds }),
      client.set(attemptsKey(email), 0, { ex: ttlSeconds }),
    ]);
  },

  async readCodeHash(email) {
    const value = await redis().get(codeKey(email));
    return value === null || value === undefined ? null : String(value);
  },

  async recordAttempt(email) {
    return redis().incr(attemptsKey(email));
  },

  /** `GETDEL` is atomic, so exactly one caller can ever consume a given code. */
  async claimCode(email) {
    const value = await redis().getdel(codeKey(email));
    return value === null || value === undefined ? null : String(value);
  },

  async invalidate(email) {
    const client = redis();
    await Promise.all([client.del(codeKey(email)), client.del(attemptsKey(email))]);
  },
};

/* -------------------------------------------------------------------------- */
/* PostgreSQL backend                                                          */
/* -------------------------------------------------------------------------- */

const prismaStore = {
  async claimRequestSlot(email, { cooldownSeconds, maxPerHour }) {
    const now = new Date();
    const [recent, hourlyCount] = await Promise.all([
      prisma.loginOtp.findFirst({
        orderBy: { createdAt: "desc" },
        where: { createdAt: { gt: new Date(now.getTime() - cooldownSeconds * 1000) }, email },
      }),
      prisma.loginOtp.count({
        where: { createdAt: { gt: new Date(now.getTime() - HOUR_SECONDS * 1000) }, email },
      }),
    ]);

    if (recent) {
      const elapsed = now.getTime() - recent.createdAt.getTime();
      return {
        allowed: false,
        reason: "cooldown",
        waitSeconds: Math.max(1, Math.ceil((cooldownSeconds * 1000 - elapsed) / 1000)),
      };
    }

    if (hourlyCount >= maxPerHour) return { allowed: false, reason: "hourly" };

    return { allowed: true };
  },

  async saveCode(email, { codeHash, requestIp, ttlSeconds, userId }) {
    const now = new Date();
    await prisma.$transaction([
      prisma.loginOtp.deleteMany({
        where: { email, expiresAt: { lt: new Date(now.getTime() - 24 * HOUR_SECONDS * 1000) } },
      }),
      prisma.loginOtp.updateMany({ data: { consumedAt: now }, where: { consumedAt: null, email } }),
      prisma.loginOtp.create({
        data: {
          codeHash,
          email,
          expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
          requestIp: requestIp || null,
          userId: userId || null,
        },
      }),
    ]);
  },

  async activeRecord(email) {
    return prisma.loginOtp.findFirst({
      orderBy: { createdAt: "desc" },
      where: { consumedAt: null, email, expiresAt: { gt: new Date() } },
    });
  },

  async readCodeHash(email) {
    const record = await this.activeRecord(email);
    return record ? record.codeHash : null;
  },

  async recordAttempt(email) {
    const record = await this.activeRecord(email);
    if (!record) return Number.MAX_SAFE_INTEGER;
    const updated = await prisma.loginOtp.update({
      data: { attempts: { increment: 1 } },
      where: { id: record.id },
    });
    return updated.attempts;
  },

  async claimCode(email) {
    const record = await this.activeRecord(email);
    if (!record) return null;
    const claimed = await prisma.loginOtp.updateMany({
      data: { consumedAt: new Date() },
      where: { consumedAt: null, id: record.id },
    });
    return claimed.count === 1 ? record.codeHash : null;
  },

  async invalidate(email) {
    await prisma.loginOtp.updateMany({ data: { consumedAt: new Date() }, where: { consumedAt: null, email } });
  },
};

const store = redisEnabled ? redisStore : prismaStore;

module.exports = {
  backend: redisEnabled ? "redis" : "postgres",
  claimCode: (email) => store.claimCode(email),
  claimRequestSlot: (email, options) => store.claimRequestSlot(email, options),
  invalidate: (email) => store.invalidate(email),
  isRedisEnabled: redisEnabled,
  readCodeHash: (email) => store.readCodeHash(email),
  recordAttempt: (email) => store.recordAttempt(email),
  saveCode: (email, options) => store.saveCode(email, options),
};
