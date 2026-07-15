# StaffFlow API

Node/Express API for StaffFlow. Firebase is used only to authenticate users; application data is stored in PostgreSQL through Prisma.

## Local Setup

1. Copy `.env.example` to `.env`.
2. Confirm `DATABASE_URL` points to your local database:

   ```bash
   postgresql://postgres:postgre@localhost:5432/postgres?schema=public
   ```

3. Configure Firebase Admin credentials with one of:
   - `FIREBASE_SERVICE_ACCOUNT_JSON`
   - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`
   - `GOOGLE_APPLICATION_CREDENTIALS`

4. Add `GEMINI_API_KEY` to enable AI task weightage and progress analysis. Without it, StaffFlow uses a deterministic fallback so local work still runs.

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
- Super admins, admins, managers, and HR can manage work.
- Accounts users can view organization project/task data without mutating it.
- HR can create and manage employee accounts.
- Tasks belong to a project and a single assignee.
- Gemini analyzes project requirements and task descriptions to assign each task a project weightage.
- Time-log comments are analyzed with task requirements to update task progress.
- Project progress is calculated from weighted task progress, not just task count.
- Employees only receive tasks and project details connected to their own assignments.
- User deletion is handled as suspension to preserve project and task history.
