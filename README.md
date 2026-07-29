# StaffFlow API

Node/Express API for StaffFlow. Firebase is used only to authenticate users; application data is stored in PostgreSQL through Prisma.

## Local Setup

1. Copy `.env.example` to `.env`.
2. Confirm `DATABASE_URL` points to your local database:

   ```bash
   postgresql://postgres:postgre@localhost:5432/postgres?schema=public
   ```

3. Configure Firebase Admin credentials with one of:
   - `FIREBASE_SERVICE_ACCOUNT_BASE64` (recommended for Vercel)
   - `FIREBASE_SERVICE_ACCOUNT_JSON`
   - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`
   - `GOOGLE_APPLICATION_CREDENTIALS` (local development only)

4. Add `GROQ_API_KEY` to enable AI planning enrichment, weightage, and progress analysis. Optionally set `GROQ_MODEL`; it defaults to `llama-3.3-70b-versatile`. Without a key, the explainable planner uses its deterministic traceable fallback.

5. Apply migrations:

   ```bash
   npm run prisma:migrate
   ```

6. Start the API:

   ```bash
   npm run dev
   ```

Public signup creates a trial organization and makes that first user `SUPER_ADMIN`. All later users are created inside the workspace through the Users module.

## Core Data Flow

- Firebase verifies identity; PostgreSQL stores users, projects, tasks, and time logs.
- Organizations own users, projects, and tasks.
- Role defaults provide initial access, while administrators can set permission overrides per account.
- Accounts users can view organization project/task data without mutating it.
- HR can create and manage employee accounts.
- Tasks belong to a project and a single assignee.
- The project planner creates immutable, requirement-traceable plan versions with milestones, dependencies, acceptance criteria, effort, skills, risks, and confidence.
- Workspace calendars, employee capacity, existing workload, deadlines, and dependencies constrain schedules and explainable assignee recommendations.
- A manager must approve or override a draft before tasks are materialized; planner evaluations measure coverage, violations, effort error, time saved, and override rate.
- Time-log comments are analyzed with task requirements to update task progress.
- Project progress is calculated from weighted task progress, not just task count.
- Employees only receive tasks and project details connected to their own assignments.
- Assignments and task/project activity create durable per-user notifications.
- Task and project activity endpoints return an entity timeline with actor details and before/after field values.
- Workspace reports summarize delivery, attendance, capacity, and project risk.
- Administrative changes are written to an organization-scoped audit log.
- User deletion is handled as suspension to preserve project and task history.
- Attendance uses server-issued challenges, database-backed office geofences, accuracy bounds, sequence checks, and retry-safe replay behavior.
- Custom module schemas are versioned and validated without allowing tenant-authored database DDL.

## Production Deployment

- Set `CORS_ORIGIN` to a comma-separated list of allowed frontend origins, including the exact Netlify origin.
- Set Firebase Admin credentials, the pooled `DATABASE_URL`, `GROQ_API_KEY`, `GROQ_MODEL`, and `CRON_SECRET` in Vercel. Do not set `GOOGLE_APPLICATION_CREDENTIALS` to a local Windows path in Vercel.
- Apply new migrations to the production database before deploying API code:

  ```bash
  npx prisma migrate deploy
  ```

For Neon, use the unpooled connection URL for migrations and the pooled `DATABASE_URL` for the Vercel runtime.

After deployment, verify:

```text
GET /health  -> API and Firebase mode
GET /ready   -> Firebase and PostgreSQL readiness
```

Run `npm test` before deployment. Service-account JSON, private keys, database passwords, and Groq keys must never be committed. Revoke and replace any credential that has been pasted into chat, an issue, or a public log.

The full operating sequence and planner research protocol live in [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) and [`docs/PLANNER_EVALUATION.md`](../docs/PLANNER_EVALUATION.md).
