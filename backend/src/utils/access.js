function getProjectRole(project, userId) {
  const id = String(userId || '');
  if (!id || !project || project.isDeleted) return null;
  if (String(project.owner?._id || project.owner || '') === id) return 'owner';
  const members = Array.isArray(project.members) ? project.members : [];
  const hit = members.find((member) => String(member?.user?._id || member?.user) === id);
  return hit?.role || null;
}

function getAccessForRole(role) {
  if (role === 'owner' || role === 'moderator' || role === 'editor') return 'write';
  if (role === 'reviewer') return 'comment';
  if (role === 'viewer') return 'read';
  return null;
}

// Project tasks need a populated `project` (owner + members). A user who is no longer
// a member loses access even if they created or were assigned the task.
function getTaskAccess(task, userId) {
  const id = String(userId || '');
  if (!id || !task) return null;
  const projectRole = task.project ? getProjectRole(task.project, id) : null;
  if (task.project && !projectRole) return null;
  if (task.project?.status === 'archived') return 'read';
  if (String(task.user?._id || task.user || '') === id) return 'owner';
  const assignees = Array.isArray(task.assignees) ? task.assignees : [];
  if (assignees.some((assignee) => String(assignee?._id || assignee) === id)) return 'write';
  return getAccessForRole(projectRole);
}

function canReadTask(task, userId) {
  return getTaskAccess(task, userId) !== null;
}

function canWriteTask(task, userId) {
  const access = getTaskAccess(task, userId);
  return access === 'owner' || access === 'write';
}

function canCommentTask(task, userId) {
  const access = getTaskAccess(task, userId);
  return access === 'owner' || access === 'write' || access === 'comment';
}

function isTaskOwner(task, userId) {
  return getTaskAccess(task, userId) === 'owner';
}

// Moving a task pulls it out of its project's schedule, so write access alone isn't enough.
function canMoveTask(task, userId) {
  if (task?.project?.status === 'archived') return false;
  if (isTaskOwner(task, userId)) return true;
  const role = task?.project ? getProjectRole(task.project, userId) : null;
  return role === 'owner' || role === 'moderator';
}

module.exports = {
  getProjectRole,
  getAccessForRole,
  getTaskAccess,
  canReadTask,
  canWriteTask,
  canCommentTask,
  isTaskOwner,
  canMoveTask,
};
