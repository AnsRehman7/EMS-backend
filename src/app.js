const cors = require("cors");
const { randomUUID } = require("crypto");
const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const { env } = require("./config/env");
const { firebaseAuthMode, firebaseAuthReady } = require("./config/firebaseAdmin");
const prisma = require("./db/prisma");
const { errorHandler, notFound } = require("./middlewares/error.middleware");
const { rateLimit } = require("./middlewares/rateLimit.middleware");
const apiRoutes = require("./routes");
const internalRoutes = require("./routes/internal.routes");
const ApiError = require("./utils/apiError");

const app = express();
const normalizeOrigin = (origin = "") => String(origin).trim().replace(/\/$/, "");
const allowedOrigins = new Set(env.corsOrigins.map(normalizeOrigin));

app.disable("x-powered-by");

app.use((req, res, next) => {
  const incomingId = String(req.headers["x-request-id"] || "").trim();
  req.requestId = incomingId.slice(0, 120) || randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
});

app.use(helmet());
app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.has("*") || allowedOrigins.has(normalizeOrigin(origin))) {
        return callback(null, true);
      }

      return callback(new ApiError(403, `Origin ${origin} is not allowed by CORS.`));
    },
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(
  env.nodeEnv === "production"
    ? morgan((tokens, req, res) =>
        JSON.stringify({
          durationMs: Number(tokens["response-time"](req, res) || 0),
          method: tokens.method(req, res),
          requestId: req.requestId,
          status: Number(tokens.status(req, res) || 0),
          timestamp: new Date().toISOString(),
          url: tokens.url(req, res),
        }),
      )
    : morgan("dev"),
);
app.use("/api", rateLimit({ limit: env.rateLimitMax }));
app.use("/api/auth", rateLimit({ keyPrefix: "auth", limit: env.authRateLimitMax, windowMs: 60_000 }));

app.get("/", (_req, res) => {
  res.status(200).json({ data: { service: "DayMark API", status: "ok" } });
});

app.get("/favicon.ico", (_req, res) => res.status(204).end());

app.get("/health", (_req, res) => {
  res.status(200).json({
    data: {
      authentication: firebaseAuthReady ? firebaseAuthMode : "unconfigured",
      service: "DayMark API",
      status: "ok",
    },
  });
});

app.get("/ready", async (_req, res) => {
  try {
    const [databaseCheck] = await prisma.$queryRaw`
      SELECT
        to_regclass('public.users') IS NOT NULL AS "usersReady",
        to_regclass('public.project_plans') IS NOT NULL AS "plannerReady",
        to_regclass('public._prisma_migrations') IS NOT NULL AS "migrationsReady"
    `;
    const schemaReady = Boolean(databaseCheck?.usersReady && databaseCheck?.plannerReady && databaseCheck?.migrationsReady);
    res.status(firebaseAuthReady && schemaReady ? 200 : 503).json({
      data: {
        authentication: firebaseAuthReady ? firebaseAuthMode : "unconfigured",
        database: schemaReady ? "migrated" : "migration_required",
        status: firebaseAuthReady && schemaReady ? "ready" : "degraded",
      },
    });
  } catch (error) {
    console.error("[ready] Database check failed:", error.message);
    res.status(503).json({
      error: {
        message: "The API is running, but its database is unavailable.",
      },
    });
  }
});

app.use("/internal", rateLimit({ keyPrefix: "internal", limit: 20, windowMs: 60_000 }), internalRoutes);
app.use("/api", apiRoutes);
app.use("/api/v1", apiRoutes);
app.use(notFound);
app.use(errorHandler);

module.exports = app;
