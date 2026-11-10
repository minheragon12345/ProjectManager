const express = require('express');
const mongoose = require('mongoose');
const TimeEntry = require('../models/timeEntryModel');
const Note = require('../models/noteModel');
const Project = require('../models/projectModel');
const auth = require('../middleware/authMiddleware');
const { writeAudit } = require('../utils/audit');
const { getProjectRole, canReadTask, canWriteTask } = require('../utils/access');

const router = express.Router();
router.use(auth);

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function parseHours(value) {
  if (value === undefined || value === null || value === '') return { error: 'hours is required' };
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: 'hours must be a number' };
  if (n <= 0) return { error: 'hours must be > 0' };
  if (n > 24) return { error: 'hours must be <= 24 per entry' };
  return Math.round(n * 100) / 100;
}

function parseDate(value) {
  if (value === undefined || value === null || value === '') {
    return new Date();
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { error: 'date must be a valid date' };
  return d;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

async function recomputeTaskActualHours(taskId) {
  if (!taskId) return;
  const agg = await TimeEntry.aggregate([
    { $match: { task: new mongoose.Types.ObjectId(String(taskId)), isDeleted: false } },
    { $group: { _id: null, total: { $sum: '$hours' } } },
  ]);
  const total = agg[0]?.total || 0;
  await Note.updateOne({ _id: taskId }, { $set: { actualHours: Math.round(total * 100) / 100 } });
}

// Owners keep control of their entries only while they can still log time on the task.
async function canChangeEntry(entry, userId) {
  if (String(entry.user) !== String(userId)) return false;
  const note = await Note.findById(entry.task).populate('project', 'owner members isDeleted status');
  return !note || canWriteTask(note, userId);
}

function toEntryDto(entry) {
  if (!entry) return null;
  return {
    id: String(entry._id),
    user: entry.user
      ? {
          id: String(entry.user._id || entry.user),
          username: entry.user.username,
          email: entry.user.email,
        }
      : null,
    task: entry.task
      ? typeof entry.task === 'object' && entry.task._id
        ? { id: String(entry.task._id), title: entry.task.title, content: entry.task.content }
        : { id: String(entry.task) }
      : null,
    project: entry.project
      ? typeof entry.project === 'object' && entry.project._id
        ? { id: String(entry.project._id), name: entry.project.name }
        : { id: String(entry.project) }
      : null,
    hours: entry.hours,
    date: entry.date,
    description: entry.description || '',
    billable: !!entry.billable,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

// POST /, create a time entry on a task the requester can write.
router.post('/', async (req, res) => {
  const { task: taskId, hours, date, description, billable } = req.body;

  if (!taskId || !isValidObjectId(taskId)) {
    return res.status(400).json({ message: 'Invalid task id' });
  }

  const parsedHours = parseHours(hours);
  if (parsedHours && typeof parsedHours === 'object' && parsedHours.error) {
    return res.status(400).json({ message: parsedHours.error });
  }

  const parsedDate = parseDate(date);
  if (parsedDate && parsedDate.error) {
    return res.status(400).json({ message: parsedDate.error });
  }

  const note = await Note.findOne({ _id: taskId, isDeleted: false })
    .populate('project', 'owner members isDeleted status');

  if (!note) return res.status(404).json({ message: 'Task not found' });
  if (!canWriteTask(note, req.userId)) {
    return res.status(403).json({ message: 'You do not have permission to log time on this task.' });
  }

  const entry = await TimeEntry.create({
    user: req.userId,
    task: note._id,
    project: note.project ? note.project._id || note.project : null,
    hours: parsedHours,
    date: parsedDate,
    description: typeof description === 'string' ? description.trim().slice(0, 1000) : '',
    billable: parseBoolean(billable, true),
  });

  await recomputeTaskActualHours(note._id);

  await writeAudit(req, {
    action: 'TIME_ENTRY_CREATE',
    targetType: 'TIME_ENTRY',
    targetId: String(entry._id),
    metadata: { taskId: String(note._id), hours: entry.hours, billable: entry.billable },
  });

  return res.status(201).json({ message: 'Time entry created', entry: toEntryDto(entry) });
});

// GET /, list entries the requester can see, filtered by task/user/project/date range.
router.get('/', async (req, res) => {
  const { task: taskId, user: userId, project: projectId, from, to, billable, limit } = req.query;
  const uid = String(req.userId);

  const and = [{ isDeleted: false }];

  if (taskId) {
    if (!isValidObjectId(taskId)) return res.status(400).json({ message: 'Invalid task id' });
    const note = await Note.findOne({ _id: taskId, isDeleted: false })
      .populate('project', 'owner members isDeleted status');
    if (!note) return res.status(404).json({ message: 'Task not found' });
    if (!canReadTask(note, uid)) return res.status(403).json({ message: 'Forbidden' });
    and.push({ task: taskId });
  }

  if (projectId) {
    if (!isValidObjectId(projectId)) return res.status(400).json({ message: 'Invalid project id' });
    const project = await Project.findOne({ _id: projectId, isDeleted: false })
      .select('owner members isDeleted')
      .lean();
    if (!project) return res.status(404).json({ message: 'Project not found' });
    const role = getProjectRole(project, uid);
    if (!role) return res.status(403).json({ message: 'Forbidden' });
    and.push({ project: projectId });
  }

  if (userId) {
    if (!isValidObjectId(userId)) return res.status(400).json({ message: 'Invalid user id' });
    and.push({ user: userId });
  }

  // If no task/project filter, scope to the requester's own entries to avoid leaking data.
  if (!taskId && !projectId) {
    and.push({ user: uid });
  }

  if (from) {
    const d = new Date(from);
    if (!Number.isNaN(d.getTime())) and.push({ date: { $gte: d } });
  }
  if (to) {
    const d = new Date(to);
    if (!Number.isNaN(d.getTime())) and.push({ date: { $lte: d } });
  }

  if (billable !== undefined) {
    const b = parseBoolean(billable, null);
    if (b !== null) and.push({ billable: b });
  }

  const cap = Math.min(Number(limit) || 200, 1000);

  const entries = await TimeEntry.find({ $and: and })
    .populate('user', 'username email')
    .populate('task', 'title content')
    .populate('project', 'name')
    .sort({ date: -1, createdAt: -1 })
    .limit(cap)
    .lean();

  const totalAgg = await TimeEntry.aggregate([
    { $match: { $and: and.map((c) => convertObjectIds(c)) } },
    { $group: { _id: null, totalHours: { $sum: '$hours' } } },
  ]);

  return res.json({
    total: entries.length,
    totalHours: Math.round((totalAgg[0]?.totalHours || 0) * 100) / 100,
    entries: entries.map(toEntryDto),
  });
});

// Convert string ids in an aggregation $match clause to ObjectIds where appropriate.
function convertObjectIds(clause) {
  const out = {};
  for (const k of Object.keys(clause)) {
    const v = clause[k];
    if (k === 'task' || k === 'project' || k === 'user') {
      if (typeof v === 'string' && isValidObjectId(v)) {
        out[k] = new mongoose.Types.ObjectId(v);
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

// GET /:id, fetch a single entry the requester can read.
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid entry id' });

  const entry = await TimeEntry.findOne({ _id: id, isDeleted: false })
    .populate('user', 'username email')
    .populate({
      path: 'task',
      select: 'title content user assignees project',
      populate: { path: 'project', select: 'owner members isDeleted' },
    })
    .populate('project', 'name owner members isDeleted status')
    .lean();

  if (!entry) return res.status(404).json({ message: 'Time entry not found' });

  const isOwner = String(entry.user?._id || entry.user) === String(req.userId);
  const canRead = isOwner || (entry.task && canReadTask(entry.task, req.userId));
  if (!canRead) return res.status(403).json({ message: 'Forbidden' });

  return res.json({ entry: toEntryDto(entry) });
});

// PUT /:id, only the entry owner can edit.
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { hours, date, description, billable } = req.body;

  if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid entry id' });

  const entry = await TimeEntry.findOne({ _id: id, isDeleted: false });
  if (!entry) return res.status(404).json({ message: 'Time entry not found' });

  if (!(await canChangeEntry(entry, req.userId))) {
    return res.status(403).json({ message: 'Only the entry owner can edit it, while they can still log time on the task.' });
  }

  let hoursChanged = false;

  if (hours !== undefined) {
    const parsed = parseHours(hours);
    if (parsed && typeof parsed === 'object' && parsed.error) {
      return res.status(400).json({ message: parsed.error });
    }
    hoursChanged = entry.hours !== parsed;
    entry.hours = parsed;
  }

  if (date !== undefined) {
    const parsed = parseDate(date);
    if (parsed && parsed.error) {
      return res.status(400).json({ message: parsed.error });
    }
    entry.date = parsed;
  }

  if (description !== undefined) {
    entry.description = typeof description === 'string' ? description.trim().slice(0, 1000) : '';
  }

  if (billable !== undefined) {
    entry.billable = parseBoolean(billable, entry.billable);
  }

  await entry.save();

  if (hoursChanged) {
    await recomputeTaskActualHours(entry.task);
  }

  await writeAudit(req, {
    action: 'TIME_ENTRY_UPDATE',
    targetType: 'TIME_ENTRY',
    targetId: String(entry._id),
    metadata: { taskId: String(entry.task), hours: entry.hours, billable: entry.billable },
  });

  return res.json({ message: 'Time entry updated', entry: toEntryDto(entry) });
});

// DELETE /:id, only the entry owner can delete (soft delete).
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid entry id' });

  const entry = await TimeEntry.findOne({ _id: id, isDeleted: false });
  if (!entry) return res.status(404).json({ message: 'Time entry not found' });

  if (!(await canChangeEntry(entry, req.userId))) {
    return res.status(403).json({ message: 'Only the entry owner can delete it, while they can still log time on the task.' });
  }

  entry.isDeleted = true;
  entry.deletedAt = new Date();
  await entry.save();

  await recomputeTaskActualHours(entry.task);

  await writeAudit(req, {
    action: 'TIME_ENTRY_DELETE',
    targetType: 'TIME_ENTRY',
    targetId: String(entry._id),
    metadata: { taskId: String(entry.task) },
  });

  return res.json({ message: 'Time entry deleted' });
});

// GET /summary/by-task?project=<id>, totals per task, scoped to a project.
router.get('/summary/by-task', async (req, res) => {
  const { project: projectId } = req.query;
  if (!projectId || !isValidObjectId(projectId)) {
    return res.status(400).json({ message: 'project query is required' });
  }

  const project = await Project.findOne({ _id: projectId, isDeleted: false })
    .select('owner members isDeleted')
    .lean();
  if (!project) return res.status(404).json({ message: 'Project not found' });
  if (!getProjectRole(project, req.userId)) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const rows = await TimeEntry.aggregate([
    { $match: { project: new mongoose.Types.ObjectId(String(projectId)), isDeleted: false } },
    {
      $group: {
        _id: '$task',
        hours: { $sum: '$hours' },
        billableHours: { $sum: { $cond: ['$billable', '$hours', 0] } },
        entries: { $sum: 1 },
      },
    },
    { $sort: { hours: -1 } },
  ]);

  return res.json({
    total: rows.length,
    rows: rows.map((r) => ({
      taskId: String(r._id),
      hours: Math.round(r.hours * 100) / 100,
      billableHours: Math.round(r.billableHours * 100) / 100,
      entries: r.entries,
    })),
  });
});

module.exports = router;
