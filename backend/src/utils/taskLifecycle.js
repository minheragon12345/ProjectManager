const mongoose = require('mongoose');
const Note = require('../models/noteModel');
const TimeEntry = require('../models/timeEntryModel');

async function recomputeParentProgress(parentId) {
  if (!parentId || !mongoose.Types.ObjectId.isValid(parentId)) return;
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

// Subtasks trashed together with their parent share its deletedAt, which is how restore finds them.
async function trashTask(note) {
  const now = new Date();
  note.isDeleted = true;
  note.deletedAt = now;
  await note.save();
  const cascade = await Note.updateMany(
    { parentTask: note._id, isDeleted: false },
    { $set: { isDeleted: true, deletedAt: now } },
  );
  if (note.parentTask) await recomputeParentProgress(note.parentTask);
  return cascade.modifiedCount || 0;
}

async function isParentInTrash(note) {
  if (!note.parentTask) return false;
  const parent = await Note.findById(note.parentTask).select('isDeleted').lean();
  return !!parent?.isDeleted;
}

// Subtasks that were trashed on their own before the parent stay in the trash.
async function restoreTask(note) {
  const deletedAt = note.deletedAt;
  note.isDeleted = false;
  note.deletedAt = null;
  await note.save();
  const cascade = deletedAt
    ? await Note.updateMany(
      { parentTask: note._id, isDeleted: true, deletedAt },
      { $set: { isDeleted: false, deletedAt: null } },
    )
    : { modifiedCount: 0 };
  if (note.parentTask) await recomputeParentProgress(note.parentTask);
  return cascade.modifiedCount || 0;
}

async function deleteTaskForever(note) {
  const subtasks = await Note.find({ parentTask: note._id }).select('_id').lean();
  const ids = [note._id, ...subtasks.map((sub) => sub._id)];
  await Note.deleteMany({ _id: { $in: ids } });
  await Note.updateMany({ dependencies: { $in: ids } }, { $pull: { dependencies: { $in: ids } } });
  const entries = await TimeEntry.deleteMany({ task: { $in: ids } });
  if (note.parentTask) await recomputeParentProgress(note.parentTask);
  return { subtasks: subtasks.length, timeEntries: entries.deletedCount || 0 };
}

module.exports = {
  recomputeParentProgress,
  trashTask,
  isParentInTrash,
  restoreTask,
  deleteTaskForever,
};
