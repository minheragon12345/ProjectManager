const express = require('express');
const mongoose = require('mongoose');
const Note = require('../models/noteModel');
const User = require('../models/userModel');
const Project = require('../models/projectModel');
const auth = require('../middleware/authMiddleware');
const { writeAudit } = require('../utils/audit');
const { escapeRegex } = require('../utils/regex');
const {
  getProjectRole,
  getTaskAccess,
  canReadTask,
  canWriteTask,
  canCommentTask,
  isTaskOwner,
} = require('../utils/access');

const router = express.Router();
const ALLOWED_STATUSES = Note.NOTE_STATUSES || ['not_done', 'done', 'cancelled'];
const ALLOWED_CATEGORIES = Note.NOTE_CATEGORIES || ['Study', 'Health', 'Finance', 'Work', 'Personal', 'Other'];

router.use(auth);

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function normalizeStatus(status) {
  if (!status) return null;
  const s = String(status).trim().toLowerCase();

  const aliases = {
    todo: 'not_done',
    pending: 'not_done',
    'not done': 'not_done',
    notdone: 'not_done',
    'chưa xong': 'not_done',
    'chua xong': 'not_done',
    chuaxong: 'not_done',

    'đã xong': 'done',
    'da xong': 'done',
    daxong: 'done',

    'đã hủy': 'cancelled',
    'da huy': 'cancelled',
    dahuy: 'cancelled',
  };

  return aliases[s] || s.replace(/\s+/g, '_');
}

function normalizeCategory(category) {
  if (category === undefined || category === null) return null;
  const c = String(category).trim();
  if (!c) return null;

  const hit = ALLOWED_CATEGORIES.find((x) => x.toLowerCase() === c.toLowerCase());
  return hit || null;
}

function parsePriority(value) {
  if (value === undefined) return undefined;
  const n = Number(value);

  if (!Number.isInteger(n)) return { error: 'priority must be an integer' };
  if (n < 0 || n > 1024) return { error: 'priority must be between 0 and 1024' };

  return n;
}

function parseProgress(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return 0;

  const n = Number(value);
  if (!Number.isFinite(n)) return { error: 'progress must be a number (0..100)' };

  const intN = Math.round(n);
  if (intN < 0 || intN > 100) return { error: 'progress must be between 0 and 100' };

  return intN;
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

// Returns { error } | { value: [ObjectId] | undefined }
async function resolveAssignees(value, projectId) {
  if (value === undefined) return { value: undefined };
  if (value === null) return { value: [] };
  if (!Array.isArray(value)) {
    return { error: 'assignees must be an array of user ids' };
  }
  const ids = Array.from(new Set(value.filter(Boolean).map(String)));
  for (const id of ids) {
    if (!isValidObjectId(id)) return { error: `Invalid assignee id: ${id}` };
  }
  if (!ids.length) return { value: [] };
  if (projectId) {
    for (const id of ids) {
      const role = await fetchProjectRole(projectId, id);
      if (!role) return { error: 'All assignees must be members of the project.' };
    }
  } else {
    const found = await User.find({ _id: { $in: ids } }).select('_id').lean();
    if (found.length !== ids.length) return { error: 'One or more assignees not found.' };
  }
  return { value: ids };
}

function derivedStatus(currentStatus, progress) {
  if (currentStatus === 'cancelled') return 'cancelled';
  if (typeof progress === 'number' && progress >= 100) return 'done';
  if (typeof progress === 'number' && progress <= 0) return 'not_done';
  return 'not_done';
}

async function countSubtasks(parentId) {
  if (!parentId) return 0;
  return Note.countDocuments({ parentTask: parentId, isDeleted: false });
}

async function recomputeParentProgress(parentId) {
  if (!parentId || !isValidObjectId(parentId)) return;
  const subs = await Note.find({ parentTask: parentId, isDeleted: false })
    .select('progress status')
    .lean();
  // Cancelled subtasks are out of scope, so they must not hold the parent below 100%.
  const active = subs.filter((sub) => sub.status !== 'cancelled');
  if (!active.length) return;
  const total = active.reduce((acc, s) => acc + (Number(s.progress) || 0), 0);
  const avg = Math.round(total / active.length);
  const status = avg >= 100 ? 'done' : 'not_done';
  await Note.updateOne(
    { _id: parentId, status: { $ne: 'cancelled' } },
    { $set: { progress: avg, status } }
  );
}

async function validateParentTask(parentTaskId, projectId, selfId) {
  if (!parentTaskId) return { value: null };
  if (!isValidObjectId(parentTaskId)) return { error: 'Invalid parentTask id' };
  if (selfId && String(parentTaskId) === String(selfId)) {
    return { error: 'A task cannot be its own parent.' };
  }
  const parent = await Note.findOne({ _id: parentTaskId, isDeleted: false })
    .select('project parentTask')
    .lean();
  if (!parent) return { error: 'Parent task not found.' };
  if (parent.parentTask) return { error: 'Subtasks cannot have their own subtasks (one level only).' };
  const parentProj = parent.project ? String(parent.project) : null;
  const targetProj = projectId ? String(projectId) : null;
  if (parentProj !== targetProj) {
    return { error: 'A subtask must live in the same project as its parent.' };
  }
  return { value: parentTaskId };
}

async function hasCycle(taskId, proposedDepIds) {
  const target = String(taskId);
  const queue = (proposedDepIds || []).map(String);
  const seen = new Set();
  while (queue.length) {
    const cur = queue.shift();
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const node = await Note.findOne({ _id: cur, isDeleted: false })
      .select('dependencies')
      .lean();
    if (!node) continue;
    for (const d of node.dependencies || []) queue.push(String(d));
  }
  return false;
}

async function validateDependencies(taskId, projectId, depIds) {
  const ids = Array.from(new Set((depIds || []).map((d) => String(d))));
  if (!ids.length) return { value: [] };
  const selfStr = String(taskId);
  if (ids.some((d) => d === selfStr)) {
    return { error: 'A task cannot depend on itself.' };
  }
  for (const d of ids) {
    if (!isValidObjectId(d)) return { error: `Invalid dependency id: ${d}` };
  }
  const found = await Note.find({ _id: { $in: ids }, isDeleted: false })
    .select('project')
    .lean();
  if (found.length !== ids.length) {
    return { error: 'One or more dependencies were not found.' };
  }
  const targetProj = projectId ? String(projectId) : null;
  for (const f of found) {
    const fp = f.project ? String(f.project) : null;
    if (fp !== targetProj) {
      return { error: 'Dependencies must be in the same project as the task.' };
    }
  }
  if (await hasCycle(taskId, ids)) {
    return { error: 'Adding this dependency would create a cycle.' };
  }
  return { value: ids };
}

function computeIsBlocked(populatedDependencies) {
  if (!Array.isArray(populatedDependencies) || !populatedDependencies.length) return false;
  return populatedDependencies.some((d) => {
    if (!d) return false;
    if (d.isDeleted) return false;
    return d.status !== 'done' && d.status !== 'cancelled';
  });
}

// Looks up a project by id and returns the user's role in it, or null.
// Used when we only have a projectId (not a populated doc).
async function fetchProjectRole(projectId, userId) {
  if (!isValidObjectId(projectId)) return null;
  const project = await Project.findOne({ _id: projectId, isDeleted: false })
    .select('owner members isDeleted')
    .lean();
  return getProjectRole(project, userId);
}

function getSearchClause(search) {
  const pattern = escapeRegex(String(search).trim());
  return {
    $or: [
      { title: { $regex: pattern, $options: 'i' } },
      { content: { $regex: pattern, $options: 'i' } },
      { category: { $regex: pattern, $options: 'i' } },
    ],
  };
}

function toOwnerDto(populatedUserOrId) {
  if (!populatedUserOrId) return null;
  if (typeof populatedUserOrId === 'string') return { id: populatedUserOrId };
  return {
    id: String(populatedUserOrId._id || ''),
    username: populatedUserOrId.username,
    email: populatedUserOrId.email,
  };
}

function toProjectDto(projectOrId) {
  if (!projectOrId) return null;
  if (typeof projectOrId === 'string') return { id: projectOrId };
  if (projectOrId._id) {
    return {
      id: String(projectOrId._id),
      name: projectOrId.name,
      isPersonal: projectOrId.isPersonal,
    };
  }
  return { id: String(projectOrId) };
}

function toAssigneeDto(assigneeOrId) {
  if (!assigneeOrId) return null;
  if (typeof assigneeOrId === 'string') return { id: assigneeOrId };
  if (assigneeOrId._id) {
    return {
      id: String(assigneeOrId._id),
      username: assigneeOrId.username,
      email: assigneeOrId.email,
    };
  }
  return { id: String(assigneeOrId) };
}

function toAssigneesDto(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(toAssigneeDto).filter(Boolean);
}

function mapNoteForList(noteLean, reqUserId, extras = {}) {
  const ownerId = String(noteLean?.user?._id || noteLean?.user || '');
  const access = getTaskAccess(noteLean, reqUserId);

  const depsArr = Array.isArray(noteLean.dependencies) ? noteLean.dependencies : [];
  const depsPopulated = depsArr.length && typeof depsArr[0] === 'object' && depsArr[0] !== null && 'status' in depsArr[0];
  const isBlocked = depsPopulated
    ? computeIsBlocked(depsArr)
    : (typeof extras.isBlocked === 'boolean' ? extras.isBlocked : false);
  const dependencyIds = depsArr.map((d) => String(d?._id || d?.id || d));

  return {
    ...noteLean,
    user: ownerId,
    owner: toOwnerDto(noteLean.user),
    project: toProjectDto(noteLean.project),
    assignees: toAssigneesDto(noteLean.assignees),
    estimatedHours: typeof noteLean.estimatedHours === 'number' ? noteLean.estimatedHours : 0,
    actualHours: typeof noteLean.actualHours === 'number' ? noteLean.actualHours : 0,
    duration: typeof noteLean.duration === 'number' ? noteLean.duration : 0,
    peopleRequired: typeof noteLean.peopleRequired === 'number' ? noteLean.peopleRequired : 1,
    minDuration: typeof noteLean.minDuration === 'number' ? noteLean.minDuration : null,
    marginalCost: typeof noteLean.marginalCost === 'number' ? noteLean.marginalCost : null,
    actualStart: noteLean.actualStart || null,
    actualEnd: noteLean.actualEnd || null,
    parentTask: noteLean.parentTask ? String(noteLean.parentTask) : null,
    dependencies: dependencyIds,
    isBlocked,
    subtaskStats: extras.subtaskStats || noteLean.subtaskStats || { total: 0, done: 0 },
    access,
    comments: undefined,
  };
}

async function attachSubtaskStats(notesLean) {
  const ids = notesLean.map((n) => n._id).filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await Note.aggregate([
    { $match: { parentTask: { $in: ids }, isDeleted: false } },
    {
      $group: {
        _id: '$parentTask',
        total: { $sum: 1 },
        done: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } },
      },
    },
  ]);
  const map = new Map();
  for (const r of rows) map.set(String(r._id), { total: r.total, done: r.done });
  return map;
}

async function computeBlockedMap(notesLean) {
  const map = new Map();
  const allDepIds = new Set();
  for (const n of notesLean) {
    for (const d of n.dependencies || []) allDepIds.add(String(d));
  }
  if (!allDepIds.size) return map;
  const deps = await Note.find({ _id: { $in: Array.from(allDepIds) } })
    .select('status isDeleted')
    .lean();
  const depStatus = new Map();
  for (const d of deps) depStatus.set(String(d._id), { status: d.status, isDeleted: d.isDeleted });
  for (const n of notesLean) {
    const blocked = (n.dependencies || []).some((d) => {
      const info = depStatus.get(String(d));
      if (!info || info.isDeleted) return false;
      return info.status !== 'done' && info.status !== 'cancelled';
    });
    map.set(String(n._id), blocked);
  }
  return map;
}

router.post('/', async (req, res) => {
  const {
    title,
    content,
    status,
    priority,
    progress,
    category,
    deadline,
    project: projectId,
    assignees: assigneesInput,
    estimatedHours,
    parentTask: parentTaskId,
    duration,
    peopleRequired,
    minDuration,
    marginalCost,
    actualStart,
    actualEnd,
  } = req.body;

  try {
    if (!content || !String(content).trim()) {
      return res.status(400).json({ message: 'content is required' });
    }

    let projectRef = null;
    if (projectId) {
      if (!isValidObjectId(projectId)) {
        return res.status(400).json({ message: 'Invalid project id' });
      }
      const role = await fetchProjectRole(projectId, req.userId);
      if (!role) return res.status(403).json({ message: 'You are not a member of this project.' });
      if (role === 'viewer' || role === 'reviewer') return res.status(403).json({ message: 'Your role does not allow creating tasks in this project.' });
      projectRef = projectId;
    }

    const parentResult = await validateParentTask(parentTaskId, projectRef, null);
    if (parentResult.error) {
      return res.status(400).json({ message: parentResult.error });
    }

    const normalizedStatus = normalizeStatus(status);
    if (normalizedStatus && !ALLOWED_STATUSES.includes(normalizedStatus)) {
      return res.status(400).json({
        message: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(', ')}`,
      });
    }

    const parsedPriority = parsePriority(priority);
    if (parsedPriority && parsedPriority.error) {
      return res.status(400).json({ message: parsedPriority.error });
    }

    const parsedProgress = parseProgress(progress);
    if (parsedProgress && parsedProgress.error) {
      return res.status(400).json({ message: parsedProgress.error });
    }

    let progressValue = typeof parsedProgress === 'number' ? parsedProgress : undefined;
    if (progressValue === undefined) {
      if (normalizedStatus === 'done') progressValue = 100;
      else if (normalizedStatus === 'not_done') progressValue = 0;
      else progressValue = 0;
    }

    const normalizedCategory = normalizeCategory(category);
    if (category !== undefined && category !== null && String(category).trim() && !normalizedCategory) {
      return res.status(400).json({ message: `Invalid category. Allowed: ${ALLOWED_CATEGORIES.join(', ')}` });
    }

    const parsedDeadline = parseDeadline(deadline);
    if (parsedDeadline && parsedDeadline.error) {
      return res.status(400).json({ message: parsedDeadline.error });
    }

    const statusValue = derivedStatus(normalizedStatus, progressValue);

    const parsedHours = parseEstimatedHours(estimatedHours);
    if (parsedHours && typeof parsedHours === 'object' && parsedHours.error) {
      return res.status(400).json({ message: parsedHours.error });
    }

    const assigneesResult = await resolveAssignees(assigneesInput, projectRef);
    if (assigneesResult.error) {
      return res.status(400).json({ message: assigneesResult.error });
    }

    const parsedDuration = parseDuration(duration);
    if (parsedDuration && typeof parsedDuration === 'object' && parsedDuration.error) {
      return res.status(400).json({ message: parsedDuration.error });
    }
    const parsedPeople = parsePeopleRequired(peopleRequired);
    if (parsedPeople && typeof parsedPeople === 'object' && parsedPeople.error) {
      return res.status(400).json({ message: parsedPeople.error });
    }
    const parsedMinDuration = parseNullableNonNegative(minDuration, 'minDuration');
    if (parsedMinDuration && typeof parsedMinDuration === 'object' && parsedMinDuration.error) {
      return res.status(400).json({ message: parsedMinDuration.error });
    }
    const parsedMarginalCost = parseNullableNonNegative(marginalCost, 'marginalCost');
    if (parsedMarginalCost && typeof parsedMarginalCost === 'object' && parsedMarginalCost.error) {
      return res.status(400).json({ message: parsedMarginalCost.error });
    }
    const parsedActualStart = parseNullableDate(actualStart, 'actualStart');
    if (parsedActualStart && typeof parsedActualStart === 'object' && parsedActualStart.error) {
      return res.status(400).json({ message: parsedActualStart.error });
    }
    const parsedActualEnd = parseNullableDate(actualEnd, 'actualEnd');
    if (parsedActualEnd && typeof parsedActualEnd === 'object' && parsedActualEnd.error) {
      return res.status(400).json({ message: parsedActualEnd.error });
    }

    const newNote = await Note.create({
      user: req.userId,
      project: projectRef,
      title: title || '',
      content,
      status: statusValue,
      progress: progressValue,
      category: normalizedCategory || 'Other',
      deadline: parsedDeadline === undefined ? null : parsedDeadline,
      priority: parsedPriority === undefined ? 0 : parsedPriority,
      assignees: assigneesResult.value === undefined ? [] : assigneesResult.value,
      estimatedHours: typeof parsedHours === 'number' ? parsedHours : 0,
      duration: typeof parsedDuration === 'number' ? parsedDuration : 0,
      peopleRequired: typeof parsedPeople === 'number' ? parsedPeople : 1,
      minDuration: parsedMinDuration === undefined ? null : parsedMinDuration,
      marginalCost: parsedMarginalCost === undefined ? null : parsedMarginalCost,
      actualStart: parsedActualStart === undefined ? null : parsedActualStart,
      actualEnd: parsedActualEnd === undefined ? null : parsedActualEnd,
      parentTask: parentResult.value || null,
      dependencies: [],
      comments: [],
      isDeleted: false,
      deletedAt: null,
    });

    if (parentResult.value) {
      await recomputeParentProgress(parentResult.value);
    }

    const populated = await Note.findById(newNote._id)
      .populate('user', 'username email')
      .populate('project', 'name isPersonal owner members isDeleted')
      .populate('assignees', 'username email')
      .lean();

    await writeAudit(req, {
      action: 'NOTE_CREATE',
      targetType: 'NOTE',
      targetId: String(newNote._id),
      metadata: {
        projectId: projectRef ? String(projectRef) : null,
        assigneeIds: assigneesResult.value || [],
        status: statusValue,
        priority: parsedPriority === undefined ? 0 : parsedPriority,
      },
    });

    return res.status(201).json({ message: 'Note created', note: mapNoteForList(populated, req.userId) });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/', async (req, res) => {
  const { status, search, category, scope, projectId } = req.query;

  try {
    const uid = String(req.userId);

    // If filtering by a specific project, verify the user is a member of that project
    // and scope the query to that project only.
    let projectScopeClause = null;
    if (projectId) {
      if (!isValidObjectId(projectId)) {
        return res.status(400).json({ message: 'Invalid projectId' });
      }
      const role = await fetchProjectRole(projectId, uid);
      if (!role) {
        return res.status(403).json({ message: 'You are not a member of this project.' });
      }
      projectScopeClause = { project: projectId };
    }

    const ownershipOr =
      scope === 'mine'
        ? [{ user: uid }]
        : scope === 'assigned'
          ? [{ assignees: uid }]
          : [{ user: uid }, { assignees: uid }];

    const and = [{ isDeleted: false }];
    if (projectScopeClause) {
      // When filtering by project, membership already grants access, no further ownership filter
      and.push(projectScopeClause);
    } else {
      and.push({ $or: ownershipOr });
    }

    if (status) {
      const normalizedStatus = normalizeStatus(status);
      if (!ALLOWED_STATUSES.includes(normalizedStatus)) {
        return res.status(400).json({
          message: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(', ')}`,
        });
      }
      and.push({ status: normalizedStatus });
    }

    if (category) {
      const normalizedCategory = normalizeCategory(category);
      if (!normalizedCategory) {
        return res.status(400).json({ message: `Invalid category. Allowed: ${ALLOWED_CATEGORIES.join(', ')}` });
      }
      and.push({ category: normalizedCategory });
    }

    if (search && String(search).trim()) and.push(getSearchClause(search));

    const query = { $and: and };

    const notes = await Note.find(query)
      .select('-comments')
      .populate('user', 'username email')
      .populate('project', 'name isPersonal owner members isDeleted')
      .populate('assignees', 'username email')
      .sort({ priority: -1, updatedAt: -1 })
      .lean();

    const subtaskStats = await attachSubtaskStats(notes);
    const blockedMap = await computeBlockedMap(notes);

    const mapped = notes
      .map((n) =>
        mapNoteForList(n, uid, {
          subtaskStats: subtaskStats.get(String(n._id)) || { total: 0, done: 0 },
          isBlocked: blockedMap.get(String(n._id)) || false,
        }),
      )
      .filter((note) => note.access);

    return res.json({ total: mapped.length, notes: mapped });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/trash', async (req, res) => {
  const { projectId, search } = req.query;
  try {
    const uid = String(req.userId);
    const and = [{ isDeleted: true }];

    if (projectId) {
      if (!isValidObjectId(projectId)) {
        return res.status(400).json({ message: 'Invalid projectId' });
      }
      const role = await fetchProjectRole(projectId, uid);
      if (!role) {
        return res.status(403).json({ message: 'You are not a member of this project.' });
      }
      and.push({ project: projectId });
    } else {
      and.push({ user: uid });
    }

    if (search && String(search).trim()) and.push(getSearchClause(search));

    const notes = await Note.find({ $and: and })
      .select('-comments')
      .populate('user', 'username email')
      .populate('project', 'name isPersonal owner members isDeleted')
      .populate('assignees', 'username email')
      .sort({ deletedAt: -1, updatedAt: -1 })
      .lean();

    const stats = await attachSubtaskStats(notes);
    const blockedMap = await computeBlockedMap(notes);
    const mapped = notes
      .map((n) =>
        mapNoteForList(n, uid, {
          subtaskStats: stats.get(String(n._id)) || { total: 0, done: 0 },
          isBlocked: blockedMap.get(String(n._id)) || false,
        }),
      )
      .filter((note) => note.access);

    return res.json({ total: mapped.length, notes: mapped });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid note id' });
    }

    const note = await Note.findOne({ _id: id, isDeleted: false })
      .select('-comments')
      .populate('user', 'username email')
      .populate('project', 'name isPersonal owner members isDeleted')
      .populate('assignees', 'username email')
      .lean();

    if (!note) return res.status(404).json({ message: 'Note not found' });

    const access = getTaskAccess(note, req.userId);
    if (!access) return res.status(403).json({ message: 'Forbidden' });

    const stats = await attachSubtaskStats([note]);
    const blockedMap = await computeBlockedMap([note]);

    const payload = mapNoteForList(note, req.userId, {
      subtaskStats: stats.get(String(note._id)) || { total: 0, done: 0 },
      isBlocked: blockedMap.get(String(note._id)) || false,
    });
    return res.json({ note: payload });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    title,
    content,
    status,
    priority,
    progress,
    category,
    deadline,
    project: projectId,
    assignees: assigneesInput,
    estimatedHours,
    parentTask: parentTaskId,
    duration,
    peopleRequired,
    minDuration,
    marginalCost,
    actualStart,
    actualEnd,
  } = req.body;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid note id' });
    }

    const note = await Note.findOne({ _id: id, isDeleted: false })
      .populate('project', 'name isPersonal owner members isDeleted');

    if (!note) return res.status(404).json({ message: 'Note not found' });

    if (!canWriteTask(note, req.userId)) {
      return res.status(403).json({ message: 'You do not have permission to edit this task.' });
    }
    const editorAccess = getTaskAccess(note, req.userId);

    // Allow moving a note to a different project; requester must be write-member of the target
    if (projectId !== undefined) {
      if (projectId === null || projectId === '') {
        note.project = null;
      } else {
        if (!isValidObjectId(projectId)) {
          return res.status(400).json({ message: 'Invalid project id' });
        }
        const role = await fetchProjectRole(projectId, req.userId);
        if (!role) return res.status(403).json({ message: 'You are not a member of this project.' });
        if (role === 'viewer' || role === 'reviewer') return res.status(403).json({ message: 'Your role does not allow moving tasks into this project.' });
        note.project = projectId;
      }
    }

    if (title !== undefined) note.title = title;
    if (content !== undefined) note.content = content;

    const previousParent = note.parentTask ? String(note.parentTask) : null;
    if (parentTaskId !== undefined) {
      if (parentTaskId === null || parentTaskId === '') {
        note.parentTask = null;
      } else {
        const ownSubs = await countSubtasks(note._id);
        if (ownSubs > 0) {
          return res.status(400).json({
            message: 'This task has subtasks; it cannot be turned into a subtask itself.',
          });
        }
        const targetProj = note.project ? String(note.project._id || note.project) : null;
        const parentResult = await validateParentTask(parentTaskId, targetProj, note._id);
        if (parentResult.error) {
          return res.status(400).json({ message: parentResult.error });
        }
        note.parentTask = parentResult.value;
      }
    }

    const subCount = await countSubtasks(note._id);
    const isParent = subCount > 0;

    if (priority !== undefined) {
      const parsedPriority = parsePriority(priority);
      if (parsedPriority && parsedPriority.error) {
        return res.status(400).json({ message: parsedPriority.error });
      }
      note.priority = parsedPriority;
    }

    if (progress !== undefined) {
      if (isParent) {
        return res.status(400).json({
          message: 'Progress is auto-computed from subtasks. Update the subtasks instead.',
        });
      }
      const parsedProgress = parseProgress(progress);
      if (parsedProgress && parsedProgress.error) {
        return res.status(400).json({ message: parsedProgress.error });
      }
      note.progress = parsedProgress;
    }

    if (category !== undefined) {
      const normalizedCategory = normalizeCategory(category);
      if (category !== null && String(category).trim() && !normalizedCategory) {
        return res.status(400).json({ message: `Invalid category. Allowed: ${ALLOWED_CATEGORIES.join(', ')}` });
      }
      note.category = normalizedCategory || 'Other';
    }

    if (deadline !== undefined) {
      const parsedDeadline = parseDeadline(deadline);
      if (parsedDeadline && parsedDeadline.error) {
        return res.status(400).json({ message: parsedDeadline.error });
      }
      note.deadline = parsedDeadline;
    }

    let isReopenedParent = false;
    if (status !== undefined) {
      const normalizedStatus = normalizeStatus(status);
      if (!normalizedStatus || !ALLOWED_STATUSES.includes(normalizedStatus)) {
        return res.status(400).json({
          message: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(', ')}`,
        });
      }

      isReopenedParent = isParent && note.status === 'cancelled' && normalizedStatus !== 'cancelled';
      if (isParent && !isReopenedParent && normalizedStatus !== 'cancelled') {
        return res.status(400).json({
          message: 'A parent task\'s status follows its subtasks. Only "cancelled" can be set directly.',
        });
      }

      note.status = isReopenedParent ? 'not_done' : normalizedStatus;
      if (!isParent && normalizedStatus === 'done' && progress === undefined) note.progress = 100;
      if (!isParent && normalizedStatus === 'not_done' && progress === undefined) note.progress = 0;
    }

    if (estimatedHours !== undefined) {
      const parsedHours = parseEstimatedHours(estimatedHours);
      if (parsedHours && typeof parsedHours === 'object' && parsedHours.error) {
        return res.status(400).json({ message: parsedHours.error });
      }
      note.estimatedHours = typeof parsedHours === 'number' ? parsedHours : 0;
    }

    if (duration !== undefined) {
      const parsed = parseDuration(duration);
      if (parsed && typeof parsed === 'object' && parsed.error) {
        return res.status(400).json({ message: parsed.error });
      }
      note.duration = typeof parsed === 'number' ? parsed : 0;
    }

    if (peopleRequired !== undefined) {
      const parsed = parsePeopleRequired(peopleRequired);
      if (parsed && typeof parsed === 'object' && parsed.error) {
        return res.status(400).json({ message: parsed.error });
      }
      note.peopleRequired = typeof parsed === 'number' ? parsed : 1;
    }

    if (minDuration !== undefined) {
      const parsed = parseNullableNonNegative(minDuration, 'minDuration');
      if (parsed && typeof parsed === 'object' && parsed.error) {
        return res.status(400).json({ message: parsed.error });
      }
      note.minDuration = parsed;
    }

    if (marginalCost !== undefined) {
      const parsed = parseNullableNonNegative(marginalCost, 'marginalCost');
      if (parsed && typeof parsed === 'object' && parsed.error) {
        return res.status(400).json({ message: parsed.error });
      }
      note.marginalCost = parsed;
    }

    if (actualStart !== undefined) {
      const parsed = parseNullableDate(actualStart, 'actualStart');
      if (parsed && typeof parsed === 'object' && parsed.error) {
        return res.status(400).json({ message: parsed.error });
      }
      note.actualStart = parsed;
    }

    if (actualEnd !== undefined) {
      const parsed = parseNullableDate(actualEnd, 'actualEnd');
      if (parsed && typeof parsed === 'object' && parsed.error) {
        return res.status(400).json({ message: parsed.error });
      }
      note.actualEnd = parsed;
    }

    if (assigneesInput !== undefined) {
      const targetProjectId = note.project ? String(note.project._id || note.project) : null;
      const assigneesResult = await resolveAssignees(assigneesInput, targetProjectId);
      if (assigneesResult.error) {
        return res.status(400).json({ message: assigneesResult.error });
      }
      note.assignees = assigneesResult.value === undefined ? note.assignees : assigneesResult.value;
    }

    if (note.content !== undefined && !String(note.content).trim()) {
      return res.status(400).json({ message: 'content cannot be empty' });
    }

    if (!isParent) {
      note.status = derivedStatus(note.status, note.progress);
    }
    await note.save();

    if (isReopenedParent) await recomputeParentProgress(note._id);
    if (note.parentTask) await recomputeParentProgress(note.parentTask);
    if (previousParent && previousParent !== String(note.parentTask || '')) {
      await recomputeParentProgress(previousParent);
    }

    await writeAudit(req, {
      action: 'NOTE_EDIT',
      targetType: 'NOTE',
      targetId: String(note._id),
      metadata: { editorAccess },
    });

    const populated = await Note.findById(note._id)
      .select('-comments')
      .populate('user', 'username email')
      .populate('project', 'name isPersonal owner members isDeleted')
      .populate('assignees', 'username email')
      .lean();

    const stats = await attachSubtaskStats([populated]);
    const blockedMap = await computeBlockedMap([populated]);

    return res.json({
      message: 'Note updated',
      note: mapNoteForList(populated, req.userId, {
        subtaskStats: stats.get(String(populated._id)) || { total: 0, done: 0 },
        isBlocked: blockedMap.get(String(populated._id)) || false,
      }),
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid note id' });
    }

    const normalizedStatus = normalizeStatus(status);
    if (!normalizedStatus || !ALLOWED_STATUSES.includes(normalizedStatus)) {
      return res.status(400).json({
        message: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(', ')}`,
      });
    }

    const note = await Note.findOne({ _id: id, isDeleted: false })
      .populate('project', 'name isPersonal owner members isDeleted');

    if (!note) return res.status(404).json({ message: 'Note not found' });
    if (!canWriteTask(note, req.userId)) {
      return res.status(403).json({ message: 'You do not have permission to edit this task.' });
    }

    const subCount = await countSubtasks(note._id);
    const isParent = subCount > 0;

    const isReopenedParent = isParent && note.status === 'cancelled' && normalizedStatus !== 'cancelled';
    if (isParent && !isReopenedParent && normalizedStatus !== 'cancelled') {
      return res.status(400).json({
        message: 'A parent task\'s status follows its subtasks. Only "cancelled" can be set directly.',
      });
    }

    note.status = isReopenedParent ? 'not_done' : normalizedStatus;
    if (!isParent && normalizedStatus === 'done') note.progress = 100;
    if (!isParent && normalizedStatus === 'not_done') note.progress = 0;

    if (!isParent) {
      note.status = derivedStatus(note.status, note.progress);
    }
    await note.save();

    if (isReopenedParent) await recomputeParentProgress(note._id);
    if (note.parentTask) await recomputeParentProgress(note.parentTask);

    await writeAudit(req, {
      action: 'NOTE_EDIT',
      targetType: 'NOTE',
      targetId: String(note._id),
      metadata: { editorAccess: getTaskAccess(note, req.userId), status: note.status, progress: note.progress },
    });

    return res.json({ message: 'Status updated', note });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid note id' });
    }

    const note = await Note.findOne({ _id: id, isDeleted: false })
      .populate('project', 'owner members isDeleted');
    if (!note) return res.status(404).json({ message: 'Note not found' });

    if (!isTaskOwner(note, req.userId)) {
      return res.status(403).json({ message: 'Only the task owner can move it to trash.' });
    }

    const now = new Date();
    note.isDeleted = true;
    note.deletedAt = now;
    await note.save();

    const cascadeResult = await Note.updateMany(
      { parentTask: note._id, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: now } },
    );

    if (note.parentTask) await recomputeParentProgress(note.parentTask);

    await writeAudit(req, {
      action: 'NOTE_TRASH',
      targetType: 'NOTE',
      targetId: String(note._id),
      metadata: { by: String(req.userId), cascadedSubtasks: cascadeResult.modifiedCount || 0 },
    });

    return res.json({
      message: 'Note moved to trash',
      note,
      cascadedSubtasks: cascadeResult.modifiedCount || 0,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/:id/restore', async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid note id' });
    }

    const note = await Note.findOne({ _id: id, isDeleted: true })
      .populate('project', 'owner members isDeleted');
    if (!note) return res.status(404).json({ message: 'Note not found in trash' });

    if (!isTaskOwner(note, req.userId)) {
      return res.status(403).json({ message: 'Only the task owner can restore it.' });
    }

    note.isDeleted = false;
    note.deletedAt = null;
    await note.save();

    const cascadeResult = await Note.updateMany(
      { parentTask: note._id, isDeleted: true },
      { $set: { isDeleted: false, deletedAt: null } },
    );

    if (note.parentTask) await recomputeParentProgress(note.parentTask);

    await writeAudit(req, {
      action: 'NOTE_RESTORE',
      targetType: 'NOTE',
      targetId: String(note._id),
      metadata: { by: String(req.userId), cascadedSubtasks: cascadeResult.modifiedCount || 0 },
    });

    return res.json({
      message: 'Note restored',
      note,
      cascadedSubtasks: cascadeResult.modifiedCount || 0,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id/hard', async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid note id' });
    }

    const note = await Note.findOne({ _id: id, isDeleted: true })
      .populate('project', 'owner members isDeleted');
    if (!note) return res.status(404).json({ message: 'Note not found in trash' });

    if (!isTaskOwner(note, req.userId)) {
      return res.status(403).json({ message: 'Only the task owner can permanently delete it.' });
    }

    const subDelete = await Note.deleteMany({ parentTask: id });
    await Note.deleteOne({ _id: id });
    await Note.updateMany(
      { dependencies: id },
      { $pull: { dependencies: id } },
    );

    await writeAudit(req, {
      action: 'NOTE_DELETE_PERMANENT',
      targetType: 'NOTE',
      targetId: String(id),
      metadata: { by: String(req.userId), cascadedSubtasks: subDelete.deletedCount || 0 },
    });

    return res.json({
      message: 'Note permanently deleted',
      cascadedSubtasks: subDelete.deletedCount || 0,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});


router.get('/:id/comments', async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid note id' });

    const note = await Note.findOne({ _id: id, isDeleted: false })
      .populate('comments.user', 'username email')
      .populate('project', 'name isPersonal owner members isDeleted');

    if (!note) return res.status(404).json({ message: 'Note not found' });
    if (!canReadTask(note, req.userId)) return res.status(403).json({ message: 'Forbidden' });

    const comments = Array.isArray(note.comments) ? [...note.comments] : [];
    comments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    return res.json({ total: comments.length, comments });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/:id/comments', async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;

  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid note id' });
    if (!text || !String(text).trim()) return res.status(400).json({ message: 'Comment text is required' });

    const note = await Note.findOne({ _id: id, isDeleted: false })
      .populate('project', 'name isPersonal owner members isDeleted');

    if (!note) return res.status(404).json({ message: 'Note not found' });
    if (!canCommentTask(note, req.userId)) {
      return res.status(403).json({ message: 'You do not have permission to comment on this task.' });
    }

    note.comments = Array.isArray(note.comments) ? note.comments : [];
    note.comments.push({ user: req.userId, text: String(text).trim(), createdAt: new Date(), updatedAt: new Date() });

    await note.save();

    await writeAudit(req, {
      action: 'NOTE_COMMENT_ADD',
      targetType: 'NOTE',
      targetId: String(note._id),
      metadata: {
        by: String(req.userId),
        textSnippet: String(text).trim().slice(0, 120),
      },
    });

    return res.status(201).json({ message: 'Comment added' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id/subtasks', async (req, res) => {
  const { id } = req.params;
  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid note id' });

    const parent = await Note.findOne({ _id: id, isDeleted: false })
      .populate('project', 'name isPersonal owner members isDeleted');
    if (!parent) return res.status(404).json({ message: 'Note not found' });
    if (!canReadTask(parent, req.userId)) return res.status(403).json({ message: 'Forbidden' });

    const subs = await Note.find({ parentTask: id, isDeleted: false })
      .select('-comments')
      .populate('user', 'username email')
      .populate('project', 'name isPersonal owner members isDeleted')
      .populate('assignees', 'username email')
      .sort({ priority: -1, updatedAt: -1 })
      .lean();

    const stats = await attachSubtaskStats(subs);
    const blockedMap = await computeBlockedMap(subs);

    const mapped = subs.map((n) =>
      mapNoteForList(n, req.userId, {
        subtaskStats: stats.get(String(n._id)) || { total: 0, done: 0 },
        isBlocked: blockedMap.get(String(n._id)) || false,
      }),
    );

    return res.json({ total: mapped.length, subtasks: mapped });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id/dependencies/blocked-by', async (req, res) => {
  const { id } = req.params;
  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid note id' });

    const note = await Note.findOne({ _id: id, isDeleted: false })
      .populate('project', 'name isPersonal owner members isDeleted');
    if (!note) return res.status(404).json({ message: 'Note not found' });
    if (!canReadTask(note, req.userId)) return res.status(403).json({ message: 'Forbidden' });

    const deps = await Note.find({ _id: { $in: note.dependencies || [] }, isDeleted: false })
      .select('title content status progress priority deadline project')
      .lean();

    return res.json({
      total: deps.length,
      dependencies: deps.map((d) => ({
        id: String(d._id),
        title: d.title || '',
        content: d.content || '',
        status: d.status,
        progress: d.progress,
        priority: d.priority,
        deadline: d.deadline,
      })),
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id/dependencies/blocks', async (req, res) => {
  const { id } = req.params;
  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid note id' });

    const note = await Note.findOne({ _id: id, isDeleted: false })
      .populate('project', 'name isPersonal owner members isDeleted');
    if (!note) return res.status(404).json({ message: 'Note not found' });
    if (!canReadTask(note, req.userId)) return res.status(403).json({ message: 'Forbidden' });

    const blocks = await Note.find({ dependencies: id, isDeleted: false })
      .select('title content status progress priority deadline')
      .lean();

    return res.json({
      total: blocks.length,
      blocks: blocks.map((b) => ({
        id: String(b._id),
        title: b.title || '',
        content: b.content || '',
        status: b.status,
        progress: b.progress,
        priority: b.priority,
        deadline: b.deadline,
      })),
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id/dependencies', async (req, res) => {
  const { id } = req.params;
  const { dependencies } = req.body;
  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid note id' });
    if (!Array.isArray(dependencies)) {
      return res.status(400).json({ message: 'dependencies must be an array' });
    }

    const note = await Note.findOne({ _id: id, isDeleted: false })
      .populate('project', 'name isPersonal owner members isDeleted');
    if (!note) return res.status(404).json({ message: 'Note not found' });
    if (!canWriteTask(note, req.userId)) {
      return res.status(403).json({ message: 'You do not have permission to edit this task.' });
    }

    const projectId = note.project ? String(note.project._id || note.project) : null;
    const result = await validateDependencies(note._id, projectId, dependencies);
    if (result.error) return res.status(400).json({ message: result.error });

    const previous = (note.dependencies || []).map((d) => String(d));
    note.dependencies = result.value;
    await note.save();

    await writeAudit(req, {
      action: 'NOTE_DEPENDENCIES_SET',
      targetType: 'NOTE',
      targetId: String(note._id),
      metadata: { previous, next: result.value },
    });

    return res.json({ message: 'Dependencies updated', dependencies: result.value });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/:id/dependencies/:depId', async (req, res) => {
  const { id, depId } = req.params;
  try {
    if (!isValidObjectId(id) || !isValidObjectId(depId)) {
      return res.status(400).json({ message: 'Invalid id' });
    }
    const note = await Note.findOne({ _id: id, isDeleted: false })
      .populate('project', 'name isPersonal owner members isDeleted');
    if (!note) return res.status(404).json({ message: 'Note not found' });
    if (!canWriteTask(note, req.userId)) {
      return res.status(403).json({ message: 'You do not have permission to edit this task.' });
    }

    const existing = (note.dependencies || []).map((d) => String(d));
    if (existing.includes(String(depId))) {
      return res.status(200).json({ message: 'Already a dependency', dependencies: existing });
    }

    const projectId = note.project ? String(note.project._id || note.project) : null;
    const next = [...existing, String(depId)];
    const result = await validateDependencies(note._id, projectId, next);
    if (result.error) return res.status(400).json({ message: result.error });

    note.dependencies = result.value;
    await note.save();

    await writeAudit(req, {
      action: 'NOTE_DEPENDENCY_ADD',
      targetType: 'NOTE',
      targetId: String(note._id),
      metadata: { added: String(depId) },
    });

    return res.json({ message: 'Dependency added', dependencies: result.value });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id/dependencies/:depId', async (req, res) => {
  const { id, depId } = req.params;
  try {
    if (!isValidObjectId(id) || !isValidObjectId(depId)) {
      return res.status(400).json({ message: 'Invalid id' });
    }
    const note = await Note.findOne({ _id: id, isDeleted: false })
      .populate('project', 'name isPersonal owner members isDeleted');
    if (!note) return res.status(404).json({ message: 'Note not found' });
    if (!canWriteTask(note, req.userId)) {
      return res.status(403).json({ message: 'You do not have permission to edit this task.' });
    }

    const before = (note.dependencies || []).map((d) => String(d));
    const after = before.filter((d) => d !== String(depId));
    if (before.length === after.length) {
      return res.status(404).json({ message: 'Dependency not found' });
    }
    note.dependencies = after;
    await note.save();

    await writeAudit(req, {
      action: 'NOTE_DEPENDENCY_REMOVE',
      targetType: 'NOTE',
      targetId: String(note._id),
      metadata: { removed: String(depId) },
    });

    return res.json({ message: 'Dependency removed', dependencies: after });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
