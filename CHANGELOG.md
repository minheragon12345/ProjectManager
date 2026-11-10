# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `backend/.env.example` and `frontend/.env.example` list the settings each app needs.
- `backend/.dockerignore` keeps local `node_modules` and `.env` out of the Docker image.
- `CORS_ORIGIN` setting lists the frontend URLs allowed to call the API, and `TRUST_PROXY` tells the API how many proxies sit in front of it.
- Estimated hours field in the task form. The Dashboard's "Estimated vs actual" card had no way to get estimates before.
- API tests (`npm run test:api` in `backend/`) check permissions, deletes, archiving and scheduling against an in-memory MongoDB. The first run downloads the MongoDB server (about 630 MB).

### Changed
- In production (`NODE_ENV=production`, which the Docker image sets) the API refuses to start without `CORS_ORIGIN`. Set it to your deployed frontend URL.
- Archived projects are read-only. Tasks, comments, dependencies and time entries can't be added or changed until the project is restored. Project settings and members stay editable.
- Unexpected server errors are now logged with the request that caused them. Invalid input (a malformed ID, failed validation, a taken username) gets a 4xx answer with a clear message instead of "Server error".
- Task status changes, trash and restore return the same task shape as the other task routes, without the project's member list.
- Dates follow the selected language instead of always using the Vietnamese format.
- The subtask and dependency panel and the time log in the task form are now translated.
- Project search waits for a short pause in typing instead of reloading the list on every keystroke.

### Removed
- Unused `body-parser` (backend) and `react-markdown` (frontend) dependencies.
- Leftover Firebase "Welcome" placeholder page in `frontend/public/`.
- Task `category` and `priority` fields, the `category` filter and the Vietnamese status aliases (such as "chưa xong"), left over from the notes app. Existing values stay in the database but are no longer read or written.
- Unused `Navbar` component.
- `frontend/pnpm-lock.yaml` and the unfinished `pnpm-workspace.yaml`. The frontend uses npm (`package-lock.json`).

### Fixed
- The backend Docker image now starts: it ran a missing `index.js` on port 3000 instead of `server.js` on port 5000.
- The page no longer requests a missing `/vite.svg` icon.
- The README pointed to a migration script that no longer exists (`migrateToPMTheory.js`, now `migrateSchema.js`).
- Project moderators and task assignees can now log time on tasks. The time-entry permission check was an outdated copy that ignored both.
- The Timeline's Constrained schedule no longer falls back to the unlimited schedule after switching tabs or saving a task.
- Time logging, My Time and Reports now use your local calendar day. In time zones ahead of UTC (such as Vietnam) the time-log form defaulted to yesterday, My Time showed each entry one day late, and Reports started the month on the previous month's last day.
- Reports now show cost by user. Billing rates were read from a project response that never included them, so every cost was 0.
- A cancelled parent task can be reopened from the task form or by dragging it on the board. Cancelled subtasks no longer stop their parent from reaching 100%.
- Removing someone from a project now unassigns them from that project's tasks. Before, those tasks could no longer be saved because the hidden assignee was rejected.
- Tasks with decimal durations (such as 0.1 and 0.2) are now marked critical correctly. Rounding errors used to leave a project with no critical tasks, so crashing analysis found nothing to shorten.
- The critical path only follows links where one task actually drives the next, so it no longer reports a chain that isn't critical.
- The Gantt chart colors every critical task red, not only the tasks on one critical chain, and the "Critical" count in its header matches the red bars.
- Crashing analysis never shortens a task below its minimum duration. When less than one unit is left it crashes only what remains, at the matching cost, and each step shows the project's real new duration.
- The Gantt chart is no longer rebuilt on every page update, which reset its scroll position.
- Gantt bars for projects measured in hours no longer end before they start.
- The API stops with a clear message when `MONGO_URI` or `JWT_SECRET` is missing or the database can't be reached. Before, it started anyway and every request failed.
- Logging in without a password returns "Invalid credentials" instead of a server error.
- Admin edits follow the same rules as the task form: a parent task's progress and status can't be set directly, and editing a subtask updates its parent's progress.
- Admin actions on tasks now show in the project's Log tab.
- The project budget card showed the billable cost as hours ("155h billable"). It now shows the amount and currency.
- New accounts get a Personal project when they register, and older accounts get one on their next login. Before, only the backfill script created it.
- The members heading on the Settings tab now counts moderators and reviewers.
- Failed project loads, creates, archives and deletes show an error instead of "Loading…" or "Project created".
- Moving a task to another project moves its time entries too, so their cost counts in the new project's budget.
- Permanently deleting a task also deletes its time entries and removes every dependency link to it and its subtasks. The leftover entries were still counted in the budget.
- An admin's permanent delete now removes the task's subtasks, dependency links and time entries. Admin trash and restore now include subtasks and update the parent task's progress.
- Restoring a task only brings back the subtasks that were trashed with it, not ones trashed on their own earlier. A subtask can't be restored while its parent is still in the trash.
- Deleting a project also removes its tasks and time entries. Before, they stayed behind and still showed up in My Time.
- The schedule no longer adds a parent task's own duration on top of its subtasks. A parent now spans its subtasks, and the subtasks wait for whatever the parent depends on.
- Cancelled tasks no longer take time or people in the schedule and are never picked for crashing.
- In the Constrained schedule, milestones and other zero-length tasks no longer wait for someone to be free.
- The resource curve follows the Constrained schedule when it is selected, includes tasks shorter than one time step, and no longer draws each change half a step early.

### Security
- Search text is now escaped before being used in database regex queries, so crafted input can no longer run slow or unintended patterns.
- People removed from a project lose access to its tasks, including tasks they created or were assigned to.
- Only a task's creator or a project owner or moderator can move it to another project. Assignees and editors could take tasks out of a project. A task can't be moved while it has a parent, subtasks or dependencies, and its assignees must belong to the new project.
- Failed logins are limited to 20 per 15 minutes and sign-ups to 20 per hour from one IP address.
- The API only accepts browser requests from the frontend URLs in `CORS_ORIGIN` instead of from any website.
- The API sends standard security headers (helmet) and no longer advertises Express.
- The login form no longer shows an account's ban reason to someone who doesn't know its password.
- Updated mongoose, body-parser, path-to-regexp, proxy-addr and qs to versions that fix known vulnerabilities.
- People who can no longer log time on a task (removed from the project, or the project is archived) can no longer edit or delete their old time entries on it.
- Audit log IP addresses can no longer be faked with an `X-Forwarded-For` header.

[Unreleased]: https://github.com/minheragon12345/project1/commits/HEAD
