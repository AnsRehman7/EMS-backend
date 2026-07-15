const axios = require("axios");
const { applicationDefault, cert, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const ApiError = require("../utils/apiError");
const { env } = require("./env");

const firebaseRestUrl = "https://identitytoolkit.googleapis.com/v1";

const hasServiceAccountJson = Boolean(env.firebaseServiceAccountJson);
const hasSplitServiceAccount = Boolean(env.firebaseProjectId && env.firebaseClientEmail && env.firebasePrivateKey);
const hasApplicationDefaultCredentials = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
const hasAdminCredential = hasServiceAccountJson || hasSplitServiceAccount || hasApplicationDefaultCredentials;
const hasRestFallback = Boolean(env.firebaseProjectId && env.firebaseWebApiKey);

const getCredential = () => {
  if (env.firebaseServiceAccountJson) {
    return cert(JSON.parse(env.firebaseServiceAccountJson));
  }

  if (hasSplitServiceAccount) {
    return cert({
      clientEmail: env.firebaseClientEmail,
      privateKey: env.firebasePrivateKey,
      projectId: env.firebaseProjectId,
    });
  }

  if (hasApplicationDefaultCredentials) {
    return applicationDefault();
  }

  return null;
};

const getAdminAuth = () => {
  if (!hasAdminCredential) return null;

  const options = { credential: getCredential() };

  if (env.firebaseProjectId) {
    options.projectId = env.firebaseProjectId;
  }

  const app = getApps()[0] || initializeApp(options);
  return getAuth(app);
};

const adminAuth = getAdminAuth();

const mapRestAuthError = (code = "") => {
  const normalizedCode = String(code).split(":")[0].trim();
  const messages = {
    EMAIL_EXISTS: "A Firebase login already exists for this email.",
    INVALID_EMAIL: "Enter a valid email address.",
    INVALID_ID_TOKEN: "Invalid or expired authentication token.",
    MISSING_ID_TOKEN: "Authentication token is required.",
    OPERATION_NOT_ALLOWED: "Enable Email/Password sign-in in Firebase Authentication.",
    PROJECT_NOT_FOUND: "Firebase project was not found. Check FIREBASE_PROJECT_ID.",
    TOO_MANY_ATTEMPTS_TRY_LATER: "Too many attempts. Please wait a moment and try again.",
    USER_DISABLED: "This Firebase account is disabled.",
    USER_NOT_FOUND: "Firebase account was not found.",
    WEAK_PASSWORD: "Password must be at least 6 characters.",
  };

  return messages[normalizedCode] || normalizedCode || "Firebase authentication failed.";
};

const missingFirebaseConfigError = () =>
  new ApiError(
    500,
    "Firebase server authentication is not configured. Add a Firebase service account or FIREBASE_WEB_API_KEY with FIREBASE_PROJECT_ID."
  );

const adminCredentialRequiredError = (action) => {
  const error = new Error(
    `${action} requires Firebase Admin credentials. Add FIREBASE_SERVICE_ACCOUNT_JSON, split service-account fields, or GOOGLE_APPLICATION_CREDENTIALS.`
  );
  error.code = "firebase/admin-credentials-required";
  return error;
};

const firebaseRestRequest = async (path, payload) => {
  if (!hasRestFallback) {
    throw missingFirebaseConfigError();
  }

  try {
    const response = await axios.post(`${firebaseRestUrl}/${path}`, payload, {
      params: { key: env.firebaseWebApiKey },
      timeout: 10000,
    });

    return response.data;
  } catch (error) {
    const restCode = error.response?.data?.error?.message || error.code;
    const authError = new Error(mapRestAuthError(restCode));
    authError.code = String(restCode || "FIREBASE_AUTH_REST_ERROR").split(":")[0].trim();
    throw authError;
  }
};

const toDecodedFirebaseUser = (user = {}) => ({
  email: user.email || "",
  email_verified: Boolean(user.emailVerified),
  firebase: {
    sign_in_provider: user.providerUserInfo?.[0]?.providerId || "password",
  },
  name: user.displayName || "",
  picture: user.photoUrl || "",
  uid: user.localId,
});

const restAuth = {
  async createUser({ disabled = false, displayName = "", email, password }) {
    if (disabled) {
      throw adminCredentialRequiredError("Creating disabled Firebase accounts");
    }

    const createdUser = await firebaseRestRequest("accounts:signUp", {
      email,
      password,
      returnSecureToken: true,
    });

    if (displayName) {
      await firebaseRestRequest("accounts:update", {
        displayName,
        idToken: createdUser.idToken,
        returnSecureToken: false,
      }).catch(() => {});
    }

    return {
      disabled: false,
      displayName,
      email,
      emailVerified: false,
      uid: createdUser.localId,
    };
  },

  async deleteUser() {
    throw adminCredentialRequiredError("Deleting Firebase accounts");
  },

  async setCustomUserClaims() {
    return undefined;
  },

  async updateUser(uid, updates = {}) {
    const protectedFields = [];

    if (updates.email) protectedFields.push("email");
    if (updates.password) protectedFields.push("password");
    if (typeof updates.disabled === "boolean") protectedFields.push("status");

    if (protectedFields.length) {
      throw adminCredentialRequiredError(`Updating Firebase ${protectedFields.join(", ")}`);
    }

    return { uid, ...updates };
  },

  async verifyIdToken(idToken) {
    const { users = [] } = await firebaseRestRequest("accounts:lookup", { idToken });
    const user = users[0];

    if (!user?.localId) {
      const error = new Error("Invalid or expired authentication token.");
      error.code = "INVALID_ID_TOKEN";
      throw error;
    }

    return toDecodedFirebaseUser(user);
  },
};

module.exports = {
  firebaseAuth: adminAuth || restAuth,
  firebaseAuthMode: adminAuth ? "admin" : "rest",
};
