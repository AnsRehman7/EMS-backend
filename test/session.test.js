const test = require("node:test");
const assert = require("node:assert/strict");
const { enforceSessionPolicy } = require("../src/middlewares/auth.middleware");
const { env } = require("../src/config/env");
const { USER_ROLES } = require("../src/utils/roles");

const secondsAgo = (seconds) => Math.floor(Date.now() / 1000) - seconds;
const day = 24 * 60 * 60;

const token = ({ authTime, provider }) => ({
  auth_time: authTime,
  firebase: { sign_in_provider: provider },
});

const employee = { role: USER_ROLES.EMPLOYEE };
const superAdmin = { role: USER_ROLES.SUPER_ADMIN };

test("an email-code session stays valid inside the configured session window", () => {
  assert.doesNotThrow(() =>
    enforceSessionPolicy(token({ authTime: secondsAgo(day), provider: "custom" }), employee),
  );
});

test("a session is rejected once it passes the configured maximum age", () => {
  const expired = token({
    authTime: secondsAgo(env.sessionMaxDays * day + 60),
    provider: "custom",
  });

  assert.throws(() => enforceSessionPolicy(expired, employee), (error) => {
    assert.equal(error.statusCode, 401);
    assert.match(error.message, /session expired/i);
    return true;
  });
});

test("session age is enforced from the original sign-in, not from token refreshes", () => {
  // A refreshed ID token is minutes old but keeps the original auth_time, which is
  // what stops silent refreshes from extending a session indefinitely.
  const refreshedButOld = token({
    authTime: secondsAgo(env.sessionMaxDays * day + 1),
    provider: "custom",
  });

  assert.throws(() => enforceSessionPolicy(refreshedButOld, superAdmin), /session expired/i);
});

test("password sign-in is refused for everyone except the super admin", () => {
  const passwordSession = token({ authTime: secondsAgo(60), provider: "password" });

  assert.throws(() => enforceSessionPolicy(passwordSession, employee), (error) => {
    assert.equal(error.statusCode, 401);
    assert.match(error.message, /Password sign-in is disabled/i);
    return true;
  });

  assert.doesNotThrow(() => enforceSessionPolicy(passwordSession, superAdmin));
});

test("retired sign-in providers are refused outright", () => {
  const googleSession = token({ authTime: secondsAgo(60), provider: "google.com" });

  for (const account of [employee, superAdmin]) {
    assert.throws(() => enforceSessionPolicy(googleSession, account), /no longer supported/i);
  }
});

test("a token without auth_time is not treated as an expired session", () => {
  // The local REST fallback omits auth_time; absence must not lock developers out.
  assert.doesNotThrow(() => enforceSessionPolicy(token({ provider: "custom" }), employee));
});
