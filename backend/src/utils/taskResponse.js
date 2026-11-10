const Note = require('../models/noteModel');
const { getTaskAccess } = require('./access');

function computeIsBlocked(populatedDependencies) {
  if (!Array.isArray(populatedDependencies) || !populatedDependencies.length) return false;
  return populatedDependencies.some((d) => {
    if (!d) return false;
    if (d.isDeleted) return false;
    return d.status !== 'done' && d.status !== 'cancelled';
  });
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

// The same task shape every route returns, without the project's member list.
async function getNoteResponse(noteId, userId) {
  const populated = await Note.findById(noteId)
    .select('-comments')
    .populate('user', 'username email')
    .populate('project', 'name isPersonal owner members isDeleted status')
    .populate('assignees', 'username email')
    .lean();
  const stats = await attachSubtaskStats([populated]);
  const blockedMap = await computeBlockedMap([populated]);
  return mapNoteForList(populated, userId, {
    subtaskStats: stats.get(String(populated._id)) || { total: 0, done: 0 },
    isBlocked: blockedMap.get(String(populated._id)) || false,
  });
}

module.exports = {
  computeIsBlocked,
  toOwnerDto,
  toProjectDto,
  toAssigneesDto,
  mapNoteForList,
  attachSubtaskStats,
  computeBlockedMap,
  getNoteResponse,
};
