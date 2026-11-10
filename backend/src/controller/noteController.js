const express = require('express');
const Note = require('../models/noteModel');
const TimeEntry = require('../models/timeEntryModel');
const auth = require('../middleware/authMiddleware');
const { writeAudit } = require('../utils/audit');
const {
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
} = require('../utils/taskFields');
const {
  recomputeParentProgress,
  trashTask,
  isParentInTrash,
  restoreTask,
  deleteTaskForever,
} = require('../utils/taskLifecycle');
const { getTaskAccess, canWriteTask, isTaskOwner, canMoveTask } = require('../utils/access');

const {
  isValidObjectId,
  resolveAssignees,
  countSubtasks,
  validateParentTask,
  fetchProjectRole,
  isProjectArchived,
  getSearchClause,
} = require('../utils/taskRules');
const { mapNoteForList, attachSubtaskStats, computeBlockedMap, getNoteResponse } = require('../utils/taskResponse');

const router = express.Router();

router.use(auth);

router.post('/', async (req, res) => {
  const {
    title,
    content,
    status,
    progress,
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
    if (await isProjectArchived(projectId)) return res.status(403).json({ message: 'This project is archived. Restore it before adding tasks.' });
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

  const parsedProgress = parseProgress(progress);
  if (parsedProgress && parsedProgress.error) {
    return res.status(400).json({ message: parsedProgress.error });
  }
  const progressValue = typeof parsedProgress === 'number' ? parsedProgress : normalizedStatus === 'done' ? 100 : 0;

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
    deadline: parsedDeadline === undefined ? null : parsedDeadline,
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
    .populate('project', 'name isPersonal owner members isDeleted status')
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
    },
  });

  return res.status(201).json({ message: 'Note created', note: mapNoteForList(populated, req.userId) });
});

router.get('/', async (req, res) => {
  const { status, search, scope, projectId } = req.query;

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

  if (search && String(search).trim()) and.push(getSearchClause(search));

  const query = { $and: and };

  const notes = await Note.find(query)
    .select('-comments')
    .populate('user', 'username email')
    .populate('project', 'name isPersonal owner members isDeleted status')
    .populate('assignees', 'username email')
    .sort({ updatedAt: -1 })
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
});

router.get('/trash', async (req, res) => {
  const { projectId, search } = req.query;
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
    .populate('project', 'name isPersonal owner members isDeleted status')
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
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;

  if (!isValidObjectId(id)) {
    return res.status(400).json({ message: 'Invalid note id' });
  }

  const note = await Note.findOne({ _id: id, isDeleted: false })
    .select('-comments')
    .populate('user', 'username email')
    .populate('project', 'name isPersonal owner members isDeleted status')
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
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    title,
    content,
    status,
    progress,
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

  if (!isValidObjectId(id)) {
    return res.status(400).json({ message: 'Invalid note id' });
  }

  const note = await Note.findOne({ _id: id, isDeleted: false })
    .populate('project', 'name isPersonal owner members isDeleted status');

  if (!note) return res.status(404).json({ message: 'Note not found' });

  if (!canWriteTask(note, req.userId)) {
    return res.status(403).json({ message: 'You do not have permission to edit this task.' });
  }
  const editorAccess = getTaskAccess(note, req.userId);

  const currentProjectId = note.project ? String(note.project._id || note.project) : null;
  const nextProjectId = projectId === undefined ? currentProjectId : projectId ? String(projectId) : null;
  const isMoving = nextProjectId !== currentProjectId;
  if (isMoving) {
    if (!canMoveTask(note, req.userId)) return res.status(403).json({ message: 'Only the task creator or a project owner or moderator can move this task to another project.' });
    if (nextProjectId && !isValidObjectId(nextProjectId)) return res.status(400).json({ message: 'Invalid project id' });
    const hasLinks = note.parentTask || note.dependencies?.length || (await countSubtasks(note._id)) > 0 || (await Note.exists({ dependencies: note._id, isDeleted: false }));
    if (hasLinks) return res.status(400).json({ message: 'Remove this task\'s parent, subtasks and dependencies before moving it to another project.' });
    if (nextProjectId) {
      const role = await fetchProjectRole(nextProjectId, req.userId);
      if (!role) return res.status(403).json({ message: 'You are not a member of this project.' });
      if (role === 'viewer' || role === 'reviewer') return res.status(403).json({ message: 'Your role does not allow moving tasks into this project.' });
      if (await isProjectArchived(nextProjectId)) return res.status(403).json({ message: 'This project is archived. Restore it before adding tasks.' });
    }
    note.project = nextProjectId;
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

  if (deadline !== undefined) {
    const parsedDeadline = parseDeadline(deadline);
    if (parsedDeadline && parsedDeadline.error) {
      return res.status(400).json({ message: parsedDeadline.error });
    }
    note.deadline = parsedDeadline;
  }

  const statusResult = applyProgressAndStatus(note, { progress, status }, isParent);
  if (statusResult.error) return res.status(400).json({ message: statusResult.error });
  const { isReopenedParent } = statusResult;

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

  // A moved task keeps its assignees only if they belong to the new project.
  if (assigneesInput !== undefined || isMoving) {
    const assigneesValue = assigneesInput !== undefined ? assigneesInput : note.assignees.map(String);
    const assigneesResult = await resolveAssignees(assigneesValue, nextProjectId);
    if (assigneesResult.error) {
      return res.status(400).json({ message: assigneesResult.error });
    }
    note.assignees = assigneesResult.value === undefined ? note.assignees : assigneesResult.value;
  }

  if (note.content !== undefined && !String(note.content).trim()) {
    return res.status(400).json({ message: 'content cannot be empty' });
  }

  await note.save();
  // Budgets add up time entries by their own project field, so they move with the task.
  if (isMoving) await TimeEntry.updateMany({ task: note._id }, { $set: { project: nextProjectId } });

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

  return res.json({ message: 'Note updated', note: await getNoteResponse(note._id, req.userId) });
});

router.patch('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!isValidObjectId(id)) {
    return res.status(400).json({ message: 'Invalid note id' });
  }

  const note = await Note.findOne({ _id: id, isDeleted: false })
    .populate('project', 'name isPersonal owner members isDeleted status');

  if (!note) return res.status(404).json({ message: 'Note not found' });
  if (!canWriteTask(note, req.userId)) {
    return res.status(403).json({ message: 'You do not have permission to edit this task.' });
  }

  const subCount = await countSubtasks(note._id);
  const isParent = subCount > 0;

  if (status === undefined) return res.status(400).json({ message: 'status is required' });
  const statusResult = applyProgressAndStatus(note, { status }, isParent);
  if (statusResult.error) return res.status(400).json({ message: statusResult.error });
  const { isReopenedParent } = statusResult;

  await note.save();

  if (isReopenedParent) await recomputeParentProgress(note._id);
  if (note.parentTask) await recomputeParentProgress(note.parentTask);

  await writeAudit(req, {
    action: 'NOTE_EDIT',
    targetType: 'NOTE',
    targetId: String(note._id),
    metadata: { editorAccess: getTaskAccess(note, req.userId), status: note.status, progress: note.progress },
  });

  return res.json({ message: 'Status updated', note: await getNoteResponse(note._id, req.userId) });
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  if (!isValidObjectId(id)) {
    return res.status(400).json({ message: 'Invalid note id' });
  }

  const note = await Note.findOne({ _id: id, isDeleted: false })
    .populate('project', 'owner members isDeleted status');
  if (!note) return res.status(404).json({ message: 'Note not found' });

  if (!isTaskOwner(note, req.userId)) {
    return res.status(403).json({ message: 'Only the task owner can move it to trash.' });
  }

  const cascadedSubtasks = await trashTask(note);

  await writeAudit(req, {
    action: 'NOTE_TRASH',
    targetType: 'NOTE',
    targetId: String(note._id),
    metadata: { by: String(req.userId), cascadedSubtasks },
  });

  return res.json({
    message: 'Note moved to trash',
    note: await getNoteResponse(note._id, req.userId),
    cascadedSubtasks,
  });
});

router.patch('/:id/restore', async (req, res) => {
  const { id } = req.params;

  if (!isValidObjectId(id)) {
    return res.status(400).json({ message: 'Invalid note id' });
  }

  const note = await Note.findOne({ _id: id, isDeleted: true })
    .populate('project', 'owner members isDeleted status');
  if (!note) return res.status(404).json({ message: 'Note not found in trash' });

  if (!isTaskOwner(note, req.userId)) {
    return res.status(403).json({ message: 'Only the task owner can restore it.' });
  }
  if (await isParentInTrash(note)) {
    return res.status(400).json({ message: 'Restore the parent task first.' });
  }

  const cascadedSubtasks = await restoreTask(note);

  await writeAudit(req, {
    action: 'NOTE_RESTORE',
    targetType: 'NOTE',
    targetId: String(note._id),
    metadata: { by: String(req.userId), cascadedSubtasks },
  });

  return res.json({
    message: 'Note restored',
    note: await getNoteResponse(note._id, req.userId),
    cascadedSubtasks,
  });
});

router.delete('/:id/hard', async (req, res) => {
  const { id } = req.params;

  if (!isValidObjectId(id)) {
    return res.status(400).json({ message: 'Invalid note id' });
  }

  const note = await Note.findOne({ _id: id, isDeleted: true })
    .populate('project', 'owner members isDeleted status');
  if (!note) return res.status(404).json({ message: 'Note not found in trash' });

  if (!isTaskOwner(note, req.userId)) {
    return res.status(403).json({ message: 'Only the task owner can permanently delete it.' });
  }

  const removed = await deleteTaskForever(note);

  await writeAudit(req, {
    action: 'NOTE_DELETE_PERMANENT',
    targetType: 'NOTE',
    targetId: String(id),
    metadata: { by: String(req.userId), cascadedSubtasks: removed.subtasks, deletedTimeEntries: removed.timeEntries },
  });

  return res.json({
    message: 'Note permanently deleted',
    cascadedSubtasks: removed.subtasks,
  });
});

module.exports = router;
