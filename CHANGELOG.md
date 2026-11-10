# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Project moderators and task assignees can now log time on tasks. The time-entry permission check was an outdated copy that ignored both.
- The Timeline's Constrained schedule no longer falls back to the unlimited schedule after switching tabs or saving a task.
- Time logging, My Time and Reports now use your local calendar day. In time zones ahead of UTC (such as Vietnam) the time-log form defaulted to yesterday, My Time showed each entry one day late, and Reports started the month on the previous month's last day.
- Reports now show cost by user. Billing rates were read from a project response that never included them, so every cost was 0.
- A cancelled parent task can be reopened from the task form or by dragging it on the board. Cancelled subtasks no longer stop their parent from reaching 100%.
- Removing someone from a project now unassigns them from that project's tasks. Before, those tasks could no longer be saved because the hidden assignee was rejected.

### Security
- Search text is now escaped before being used in database regex queries, so crafted input can no longer run slow or unintended patterns.
- People removed from a project lose access to its tasks, including tasks they created or were assigned to.

[Unreleased]: https://github.com/minheragon12345/project1/commits/HEAD
