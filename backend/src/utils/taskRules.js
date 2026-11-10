const mongoose = require('mongoose');
const Note = require('../models/noteModel');
const User = require('../models/userModel');
const Project = require('../models/projectModel');
const { escapeRegex } = require('./regex');
const { getProjectRole } = require('./access');

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
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

async function countSubtasks(parentId) {
  if (!parentId) return 0;
  return Note.countDocuments({ parentTask: parentId, isDeleted: false });
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

// Looks up a project by id and returns the user's role in it, or null.
// Used when we only have a projectId (not a populated doc).
async function fetchProjectRole(projectId, userId) {
  if (!isValidObjectId(projectId)) return null;
  const project = await Project.findOne({ _id: projectId, isDeleted: false })
    .select('owner members isDeleted')
    .lean();
  return getProjectRole(project, userId);
}

async function isProjectArchived(projectId) {
  return !!(await Project.exists({ _id: projectId, status: 'archived' }));
}

function getSearchClause(search) {
  const pattern = escapeRegex(String(search).trim());
  return {
    $or: [
      { title: { $regex: pattern, $options: 'i' } },
      { content: { $regex: pattern, $options: 'i' } },
    ],
  };
}

module.exports = {
  isValidObjectId,
  resolveAssignees,
  countSubtasks,
  validateParentTask,
  hasCycle,
  validateDependencies,
  fetchProjectRole,
  isProjectArchived,
  getSearchClause,
};
