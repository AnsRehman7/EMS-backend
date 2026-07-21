const cors = require("cors");
const { randomUUID } = require("crypto");
const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const { env } = require("./config/env");
const { firebaseAuthMode, firebaseAuthReady } = require("./config/firebaseAdmin");
const prisma = require("./db/prisma");
const { errorHandler, notFound } = require("./middlewares/error.middleware");
const apiRoutes = require("./routes");
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
app.use(morgan(env.nodeEnv === "production" ? "combined" : "dev"));

app.get("/", (_req, res) => {
  res.status(200).json({ data: { service: "StaffFlow API", status: "ok" } });
});

app.get("/favicon.ico", (_req, res) => res.status(204).end());

app.get("/health", (_req, res) => {
  res.status(200).json({
    data: {
      authentication: firebaseAuthReady ? firebaseAuthMode : "unconfigured",
      service: "StaffFlow API",
      status: "ok",
    },
  });
});

app.get("/ready", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(firebaseAuthReady ? 200 : 503).json({
      data: {
        authentication: firebaseAuthReady ? firebaseAuthMode : "unconfigured",
        database: "connected",
        status: firebaseAuthReady ? "ready" : "degraded",
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

app.use("/api", apiRoutes);
app.use(notFound);
app.use(errorHandler);

module.exports = app;
