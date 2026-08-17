-- Passwordless email sign-in codes. Only an HMAC of the code is persisted.
CREATE TABLE IF NOT EXISTS "login_otps" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "requestIp" TEXT,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "login_otps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "login_otps_email_consumedAt_expiresAt_idx"
  ON "login_otps" ("email", "consumedAt", "expiresAt");
CREATE INDEX IF NOT EXISTS "login_otps_email_createdAt_idx" ON "login_otps" ("email", "createdAt");
CREATE INDEX IF NOT EXISTS "login_otps_expiresAt_idx" ON "login_otps" ("expiresAt");
