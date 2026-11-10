const Note = require('../models/noteModel');

const ALLOWED_STATUSES = Note.NOTE_STATUSES || ['not_done', 'done', 'cancelled'];

function normalizeStatus(status) {
  if (!status) return null;
  return String(status).trim().toLowerCase().replace(/\s+/g, '_');
}

function parseProgress(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: 'progress must be a number (0..100)' };
  const rounded = Math.round(n);
  if (rounded < 0 || rounded > 100) return { error: 'progress must be between 0 and 100' };
  return rounded;
}

function parseDeadline(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { error: 'deadline must be a valid date' };
  return d;
}

function parseDuration(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: 'duration must be a number' };
  if (n < 0) return { error: 'duration must be >= 0' };
  if (n > 100000) return { error: 'duration must be <= 100000' };
  return Math.round(n * 100) / 100;
}

function parsePeopleRequired(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return 1;
  const n = Number(value);
  if (!Number.isInteger(n)) return { error: 'peopleRequired must be an integer' };
  if (n < 1) return { error: 'peopleRequired must be >= 1' };
  if (n > 10000) return { error: 'peopleRequired must be <= 10000' };
  return n;
}

function parseNullableNonNegative(value, label) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: `${label} must be a number` };
  if (n < 0) return { error: `${label} must be >= 0` };
  return Math.round(n * 100) / 100;
}

function parseNullableDate(value, label) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { error: `${label} must be a valid date` };
  return d;
}

function parseEstimatedHours(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: 'estimatedHours must be a number' };
  if (n < 0) return { error: 'estimatedHours must be >= 0' };
  if (n > 10000) return { error: 'estimatedHours must be <= 10000' };
  return Math.round(n * 100) / 100;
}

function derivedStatus(currentStatus, progress) {
  if (currentStatus === 'cancelled') return 'cancelled';
  if (typeof progress === 'number' && progress >= 100) return 'done';
  return 'not_done';
}

// One set of rules for the task form, the board's status change and the admin edit.
// A parent's progress and status follow its subtasks; it can only be cancelled or reopened.
// Returns { error } or { isReopenedParent }.
function applyProgressAndStatus(note, { progress, status }, isParent) {
  if (progress !== undefined) {
    if (isParent) return { error: 'Progress is auto-computed from subtasks. Update the subtasks instead.' };
    const parsed = parseProgress(progress);
    if (parsed?.error) return parsed;
    note.progress = parsed;
  }

  let isReopenedParent = false;
  if (status !== undefined) {
    const normalized = normalizeStatus(status);
    if (!ALLOWED_STATUSES.includes(normalized)) return { error: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(', ')}` };
    isReopenedParent = isParent && note.status === 'cancelled' && normalized !== 'cancelled';
    if (isParent && !isReopenedParent && normalized !== 'cancelled') return { error: 'A parent task\'s status follows its subtasks. Only "cancelled" can be set directly.' };
    note.status = isReopenedParent ? 'not_done' : normalized;
    if (!isParent && normalized === 'done' && progress === undefined) note.progress = 100;
    if (!isParent && normalized === 'not_done' && progress === undefined) note.progress = 0;
  }

  if (!isParent) note.status = derivedStatus(note.status, note.progress);
  return { isReopenedParent };
}

module.exports = {
  ALLOWED_STATUSES,
  normalizeStatus,
  parseProgress,
  parseDeadline,
  parseDuration,
  parsePeopleRequired,
  parseNullableNonNegative,
  parseNullableDate,
  parseEstimatedHours,
  derivedStatus,
  applyProgressAndStatus,
};
