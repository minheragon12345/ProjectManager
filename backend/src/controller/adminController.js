const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/userModel');
const Note = require('../models/noteModel');
const AuditLog = require('../models/auditLogModel');
const auth = require('../middleware/authMiddleware');
const requireRole = require('../middleware/requireRole');
const { writeAudit } = require('../utils/audit');
const { escapeRegex } = require('../utils/regex');
const { recomputeParentProgress, trashTask, isParentInTrash, restoreTask, deleteTaskForever } = require('../utils/taskLifecycle');
const { parseDeadline, applyProgressAndStatus } = require('../utils/taskFields');

const router = express.Router();

router.use(auth);

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// Users
router.get('/users', requireRole('admin'), async (req, res) => {
  const { search } = req.query;
  const query = {};
  if (search && String(search).trim()) {
    const keyword = escapeRegex(String(search).trim());
    query.$or = [
      { username: { $regex: keyword, $options: 'i' } },
      { email: { $regex: keyword, $options: 'i' } },
    ];
  }

  const users = await User.find(query)
    .select('-password')
    .sort({ createdAt: -1 });

  return res.json({ total: users.length, users });
});

router.get('/users-lite', requireRole('admin', 'moderator'), async (req, res) => {
  const users = await User.find({})
    .select('_id username email role isBanned')
    .sort({ username: 1 });
  return res.json({ total: users.length, users });
});

router.patch('/users/:id/role', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!isValidObjectId(id)) {
    return res.status(400).json({ message: 'Invalid user id' });
  }

  const allowedRoles = User.USER_ROLES || ['user', 'moderator', 'admin'];
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (!allowedRoles.includes(normalizedRole)) {
    return res.status(400).json({ message: `Invalid role. Allowed: ${allowedRoles.join(', ')}` });
  }

  if (String(req.user.id) === String(id) && normalizedRole !== 'admin') {
    return res.status(400).json({ message: 'You cannot change your own role away from admin.' });
  }

  const before = await User.findById(id).select('_id role');
  if (!before) return res.status(404).json({ message: 'User not found' });

  const user = await User.findByIdAndUpdate(
    id,
    { role: normalizedRole },
    { new: true, runValidators: true }
  ).select('-password');

  await writeAudit(req, {
    action: 'USER_ROLE_UPDATE',
    targetType: 'USER',
    targetId: id,
    metadata: { from: before.role, to: normalizedRole },
  });

  return res.json({ message: 'Role updated', user });
});

// Billing rate
router.patch('/users/:id/billing-rate', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { billingRate, billingCurrency } = req.body;

  if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid user id' });

  const updates = {};
  if (billingRate !== undefined) {
    const n = Number(billingRate);
    if (!Number.isFinite(n)) return res.status(400).json({ message: 'billingRate must be a number' });
    if (n < 0) return res.status(400).json({ message: 'billingRate must be >= 0' });
    if (n > 100000) return res.status(400).json({ message: 'billingRate must be <= 100000' });
    updates.billingRate = Math.round(n * 100) / 100;
  }
  if (billingCurrency !== undefined) {
    const s = String(billingCurrency || '').trim().toUpperCase();
    if (s.length === 0 || s.length > 8) return res.status(400).json({ message: 'billingCurrency must be 1-8 chars' });
    updates.billingCurrency = s;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ message: 'No changes provided' });
  }

  const before = await User.findById(id).select('_id billingRate billingCurrency');
  if (!before) return res.status(404).json({ message: 'User not found' });

  const user = await User.findByIdAndUpdate(id, updates, {
    new: true,
    runValidators: true,
  }).select('-password');

  await writeAudit(req, {
    action: 'USER_BILLING_UPDATE',
    targetType: 'USER',
    targetId: id,
    metadata: {
      from: { billingRate: before.billingRate, billingCurrency: before.billingCurrency },
      to: { billingRate: user.billingRate, billingCurrency: user.billingCurrency },
    },
  });

  return res.json({ message: 'Billing rate updated', user });
});

// Ban
router.patch('/users/:id/ban', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { isBanned, reason } = req.body;

  if (!isValidObjectId(id)) {
    return res.status(400).json({ message: 'Invalid user id' });
  }

  if (String(req.user.id) === String(id)) {
    return res.status(400).json({ message: 'You cannot ban yourself.' });
  }

  const user = await User.findById(id).select('-password');
  if (!user) return res.status(404).json({ message: 'User not found' });

  const ban = Boolean(isBanned);
  if (ban) {
    user.isBanned = true;
    user.bannedAt = new Date();
    user.banReason = String(reason || '').trim();
    user.bannedBy = req.user.id;
    await user.save();

    await writeAudit(req, {
      action: 'USER_BAN',
      targetType: 'USER',
      targetId: id,
      metadata: { reason: user.banReason || '' },
    });

    return res.json({ message: 'User banned', user });
  }

  user.isBanned = false;
  user.bannedAt = null;
  user.banReason = '';
  user.bannedBy = null;
  await user.save();

  await writeAudit(req, {
    action: 'USER_UNBAN',
    targetType: 'USER',
    targetId: id,
    metadata: {},
  });

  return res.json({ message: 'User unbanned', user });
});

router.get('/notes', requireRole('admin', 'moderator'), async (req, res) => {
  const { userId, includeDeleted, search } = req.query;

  const query = {};

  if (userId) {
    if (!isValidObjectId(userId)) {
      return res.status(400).json({ message: 'Invalid userId' });
    }
    query.user = userId;
  }

  if (!String(includeDeleted || '').toLowerCase().includes('true')) {
    query.isDeleted = false;
  }

  if (search && String(search).trim()) {
    const keyword = escapeRegex(String(search).trim());
    query.$or = [
      { title:{ $regex: keyword, $options: 'i' } },
      { content: { $regex: keyword, $options: 'i' } },
    ];
  }

  const notes = await Note.find(query)
    .populate('user', 'username email role')
    .sort({ updatedAt: -1 });

  return res.json({ total: notes.length, notes });
});

// Edit
router.patch('/notes/:id', requireRole('admin', 'moderator'), async (req, res) => {
  const { id } = req.params;
  const { title, content, status, progress, deadline } = req.body;

  if (!isValidObjectId(id)) {
    return res.status(400).json({ message: 'Invalid note id' });
  }

  const note = await Note.findById(id);
  if (!note) return res.status(404).json({ message: 'Note not found' });

  const before = {
    title: note.title,
    content: note.content,
    status: note.status,
    progress: note.progress,
    deadline: note.deadline,
    isDeleted: note.isDeleted,
  };

  if (typeof title !== 'undefined') note.title = title;
  if (typeof content !== 'undefined') note.content = content;

  if (typeof deadline !== 'undefined') {
    const parsedDeadline = parseDeadline(deadline);
    if (parsedDeadline && parsedDeadline.error) {
      return res.status(400).json({ message: parsedDeadline.error });
    }
    note.deadline = parsedDeadline;
  }

  const isParent = (await Note.countDocuments({ parentTask: note._id, isDeleted: false })) > 0;
  const statusResult = applyProgressAndStatus(note, { progress, status }, isParent);
  if (statusResult.error) return res.status(400).json({ message: statusResult.error });

  if (typeof note.content !== 'undefined' && !String(note.content).trim()) {
    return res.status(400).json({ message: 'content cannot be empty' });
  }

  await note.save();
  if (statusResult.isReopenedParent) await recomputeParentProgress(note._id);
  if (note.parentTask) await recomputeParentProgress(note.parentTask);

  await writeAudit(req, {
    action: 'NOTE_EDIT',
    targetType: 'NOTE',
    targetId: id,
    metadata: {
      noteUser: String(note.user),
      before,
      after: {
        title: note.title,
        content: note.content,
        status: note.status,
        progress: note.progress,
        deadline: note.deadline,
        isDeleted: note.isDeleted,
      },
    },
  });

  const populated = await Note.findById(id).populate('user', 'username email role');
  return res.json({ message: 'Note updated', note: populated });
});

// Soft-delete
router.patch('/notes/:id/trash', requireRole('admin', 'moderator'), async (req, res) => {
  const { id } = req.params;

  if (!isValidObjectId(id)) {
    return res.status(400).json({ message: 'Invalid note id' });
  }

  const note = await Note.findOne({ _id: id, isDeleted: false });
  if (!note) return res.status(404).json({ message: 'Note not found' });

  const cascadedSubtasks = await trashTask(note);

  await writeAudit(req, {
    action: 'NOTE_TRASH',
    targetType: 'NOTE',
    targetId: id,
    metadata: { noteUser: String(note.user), cascadedSubtasks },
  });

  const populated = await Note.findById(id).populate('user', 'username email role');
  return res.json({ message: 'Note trashed', note: populated });
});

// Restore
router.patch('/notes/:id/restore', requireRole('admin', 'moderator'), async (req, res) => {
  const { id } = req.params;

  if (!isValidObjectId(id)) {
    return res.status(400).json({ message: 'Invalid note id' });
  }

  const note = await Note.findOne({ _id: id, isDeleted: true });
  if (!note) return res.status(404).json({ message: 'Note not found in trash' });
  if (await isParentInTrash(note)) return res.status(400).json({ message: 'Restore the parent task first.' });

  const cascadedSubtasks = await restoreTask(note);

  await writeAudit(req, {
    action: 'NOTE_RESTORE',
    targetType: 'NOTE',
    targetId: id,
    metadata: { noteUser: String(note.user), cascadedSubtasks },
  });

  const populated = await Note.findById(id).populate('user', 'username email role');
  return res.json({ message: 'Note restored', note: populated });
});

// Delete
router.delete('/notes/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;

  if (!isValidObjectId(id)) {
    return res.status(400).json({ message: 'Invalid note id' });
  }

  const note = await Note.findById(id).select('_id user title parentTask');
  if (!note) return res.status(404).json({ message: 'Note not found' });

  const removed = await deleteTaskForever(note);

  await writeAudit(req, {
    action: 'NOTE_DELETE_PERMANENT',
    targetType: 'NOTE',
    targetId: id,
    metadata: { noteUser: String(note.user), title: note.title || '', cascadedSubtasks: removed.subtasks, deletedTimeEntries: removed.timeEntries },
  });

  return res.json({ message: 'Note permanently deleted' });
});

// Logs
router.get('/audit-logs', requireRole('admin'), async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limitRaw = parseInt(req.query.limit || '100', 10);
  const limit = Math.min(Math.max(limitRaw, 1), 500);
  const skip = (page - 1) * limit;

  const { actorId, action, targetType, targetId, dateFrom, dateTo } = req.query;

  const query = {};
  if (actorId) {
    if (!isValidObjectId(actorId)) return res.status(400).json({ message: 'Invalid actorId' });
    query.actor = actorId;
  }
  if (action && String(action).trim()) query.action = String(action).trim();
  // Older admin entries were saved as 'Note' and 'User'.
  if (targetType && String(targetType).trim()) query.targetType = { $regex: `^${escapeRegex(String(targetType).trim())}$`, $options: 'i' };
  if (typeof targetId !== 'undefined' && String(targetId).trim()) query.targetId = String(targetId).trim();

  if (dateFrom || dateTo) {
    query.createdAt = {};
    if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
    if (dateTo) query.createdAt.$lte = new Date(dateTo);
  }

  const [total, logs] = await Promise.all([
    AuditLog.countDocuments(query),
    AuditLog.find(query)
      .populate('actor', 'username email role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
  ]);

  return res.json({ total, page, limit, logs });
});

module.exports = router;
