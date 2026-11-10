const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/userModel');
const Note = require('../models/noteModel');
const AuditLog = require('../models/auditLogModel');
const auth = require('../middleware/authMiddleware');
const requireRole = require('../middleware/requireRole');
const { writeAudit } = require('../utils/audit');
const { escapeRegex } = require('../utils/regex');

const router = express.Router();

router.use(auth);

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}


const ALLOWED_NOTE_STATUSES = Note.NOTE_STATUSES || ['not_done', 'done', 'cancelled'];
const ALLOWED_NOTE_CATEGORIES = Note.NOTE_CATEGORIES || ['Study', 'Health', 'Finance', 'Work', 'Personal', 'Other'];

function normalizeNoteStatus(status) {
  if (status === undefined || status === null) return null;
  return String(status).trim().toLowerCase();
}

function normalizeNoteCategory(category) {
  if (category === undefined || category === null) return null;
  const c = String(category).trim();
  if (!c) return null;
  const hit = ALLOWED_NOTE_CATEGORIES.find((x) => x.toLowerCase() === c.toLowerCase());
  return hit || null;
}

function parseNotePriority(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) return { error: 'priority must be an integer' };
  if (n < 0 || n > 1024) return { error: 'priority must be between 0 and 1024' };
  return n;
}

function parseNoteProgress(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: 'progress must be a number (0..100)' };
  const intN = Math.round(n);
  if (intN < 0 || intN > 100) return { error: 'progress must be between 0 and 100' };
  return intN;
}

function parseNoteDeadline(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { error: 'deadline must be a valid date' };
  return d;
}

function deriveNoteStatus(currentStatus, progress) {
  if (currentStatus === 'cancelled') return 'cancelled';
  if (typeof progress === 'number' && progress >= 100) return 'done';
  if (typeof progress === 'number' && progress <= 0) return 'not_done';
  return 'not_done';
}

// Users
router.get('/users', requireRole('admin'), async (req, res) => {
  try {
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
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/users-lite', requireRole('admin', 'moderator'), async (req, res) => {
  try {
    const users = await User.find({})
      .select('_id username email role isBanned')
      .sort({ username: 1 });
    return res.json({ total: users.length, users });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/users/:id/role', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  try {
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
      targetType: 'User',
      targetId: id,
      metadata: { from: before.role, to: normalizedRole },
    });

    return res.json({ message: 'Role updated', user });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// Billing rate
router.patch('/users/:id/billing-rate', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { billingRate, billingCurrency } = req.body;

  try {
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
      targetType: 'User',
      targetId: id,
      metadata: {
        from: { billingRate: before.billingRate, billingCurrency: before.billingCurrency },
        to: { billingRate: user.billingRate, billingCurrency: user.billingCurrency },
      },
    });

    return res.json({ message: 'Billing rate updated', user });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// Ban
router.patch('/users/:id/ban', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { isBanned, reason } = req.body;

  try {
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
        targetType: 'User',
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
      targetType: 'User',
      targetId: id,
      metadata: {},
    });

    return res.json({ message: 'User unbanned', user });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/notes', requireRole('admin', 'moderator'), async (req, res) => {
  const { userId, includeDeleted, search } = req.query;

  try {
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
        { category: { $regex: keyword, $options: 'i' } },
      ];
    }

    const notes = await Note.find(query)
      .populate('user', 'username email role')
      .sort({ updatedAt: -1 });

    return res.json({ total: notes.length, notes });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// Edit
router.patch('/notes/:id', requireRole('admin', 'moderator'), async (req, res) => {
  const { id } = req.params;
  const { title, content, status, priority, progress, category, deadline } = req.body;

  try {
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
      category: note.category,
      deadline: note.deadline,
      priority: note.priority,
      isDeleted: note.isDeleted,
    };

    if (typeof title !== 'undefined') note.title = title;
    if (typeof content !== 'undefined') note.content = content;

    if (typeof priority !== 'undefined') {
      const parsedPriority = parseNotePriority(priority);
      if (parsedPriority && parsedPriority.error) {
        return res.status(400).json({ message: parsedPriority.error });
      }
      note.priority = parsedPriority;
    }

    if (typeof progress !== 'undefined') {
      const parsedProgress = parseNoteProgress(progress);
      if (parsedProgress && parsedProgress.error) {
        return res.status(400).json({ message: parsedProgress.error });
      }
      note.progress = parsedProgress;
    }

    if (typeof category !== 'undefined') {
      const normalizedCategory = normalizeNoteCategory(category);
      if (category !== null && String(category).trim() && !normalizedCategory) {
        return res.status(400).json({ message: `Invalid category. Allowed: ${ALLOWED_NOTE_CATEGORIES.join(', ')}` });
      }
      note.category = normalizedCategory || 'Other';
    }

    if (typeof deadline !== 'undefined') {
      const parsedDeadline = parseNoteDeadline(deadline);
      if (parsedDeadline && parsedDeadline.error) {
        return res.status(400).json({ message: parsedDeadline.error });
      }
      note.deadline = parsedDeadline;
    }

    if (typeof status !== 'undefined') {
      const normalizedStatus = normalizeNoteStatus(status);
      if (!normalizedStatus || !ALLOWED_NOTE_STATUSES.includes(normalizedStatus)) {
        return res.status(400).json({ message: `Invalid status. Allowed: ${ALLOWED_NOTE_STATUSES.join(', ')}` });
      }

      note.status = normalizedStatus;
      if (normalizedStatus === 'done' && typeof progress === 'undefined') note.progress = 100;
      if (normalizedStatus === 'not_done' && typeof progress === 'undefined') note.progress = 0;
    }

    if (typeof note.content !== 'undefined' && !String(note.content).trim()) {
      return res.status(400).json({ message: 'content cannot be empty' });
    }

    note.status = deriveNoteStatus(note.status, note.progress);
    await note.save();
    await writeAudit(req, {
      action: 'NOTE_EDIT',
      targetType: 'Note',
      targetId: id,
      metadata: {
        noteUser: String(note.user),
        before,
        after: {
          title: note.title,
          content: note.content,
          status: note.status,
          progress: note.progress,
          category: note.category,
          deadline: note.deadline,
          priority: note.priority,
          isDeleted: note.isDeleted,
        },
      },
    });

    const populated = await Note.findById(id).populate('user', 'username email role');
    return res.json({ message: 'Note updated', note: populated });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// Soft-delete
router.patch('/notes/:id/trash', requireRole('admin', 'moderator'), async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid note id' });
    }

    const note = await Note.findById(id);
    if (!note) return res.status(404).json({ message: 'Note not found' });

    note.isDeleted = true;
    note.deletedAt = new Date();
    await note.save();

    await writeAudit(req, {
      action: 'NOTE_TRASH',
      targetType: 'Note',
      targetId: id,
      metadata: { noteUser: String(note.user) },
    });

    const populated = await Note.findById(id).populate('user', 'username email role');
    return res.json({ message: 'Note trashed', note: populated });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// Restore
router.patch('/notes/:id/restore', requireRole('admin', 'moderator'), async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid note id' });
    }

    const note = await Note.findById(id);
    if (!note) return res.status(404).json({ message: 'Note not found' });

    note.isDeleted = false;
    note.deletedAt = null;
    await note.save();

    await writeAudit(req, {
      action: 'NOTE_RESTORE',
      targetType: 'Note',
      targetId: id,
      metadata: { noteUser: String(note.user) },
    });

    const populated = await Note.findById(id).populate('user', 'username email role');
    return res.json({ message: 'Note restored', note: populated });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// Delete
router.delete('/notes/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid note id' });
    }

    const note = await Note.findById(id).select('_id user title');
    if (!note) return res.status(404).json({ message: 'Note not found' });

    await Note.findByIdAndDelete(id);

    await writeAudit(req, {
      action: 'NOTE_DELETE_PERMANENT',
      targetType: 'Note',
      targetId: id,
      metadata: { noteUser: String(note.user), title: note.title || '' },
    });

    return res.json({ message: 'Note permanently deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// Logs
router.get('/audit-logs', requireRole('admin'), async (req, res) => {
  try {
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
    if (targetType && String(targetType).trim()) query.targetType = String(targetType).trim();
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
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
