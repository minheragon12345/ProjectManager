const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');
const User = require('../models/userModel');
const auth = require('../middleware/authMiddleware');
const { ensurePersonalProject } = require('../utils/personalProject');

const router = express.Router();

// Successful logins don't count, so only repeated wrong passwords get blocked.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many failed login attempts. Try again in 15 minutes.' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many sign-ups from this network. Try again later.' },
});

router.post('/register', registerLimiter, async (req, res) => {
  const { username, email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (!username || !normalizedEmail || !password) {
    return res.status(400).json({ message: 'All fields are required' });
  }
  if (String(password).length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });

  const userExists = await User.findOne({ email: normalizedEmail });
  if (userExists) {
    return res.status(400).json({ message: 'User already exists' });
  }

  const newUser = await User.create({ username, email: normalizedEmail, password, role: 'user' });
  await ensurePersonalProject(newUser._id);
  const userResponse = newUser.toObject();
  delete userResponse.password;

  return res.status(201).json({ message: 'User registered successfully', user: userResponse });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    return res.status(400).json({ message: 'Invalid credentials' });
  }

  const isMatch = await bcrypt.compare(String(password || ''), user.password);
  if (!isMatch) {
    return res.status(400).json({ message: 'Invalid credentials' });
  }

  // Checked after the password so the ban reason is only shown to the account holder.
  if (user.isBanned) {
    return res.status(403).json({
      message: user.banReason ? `Account is banned: ${user.banReason}` : 'Account is banned',
      code: 'USER_BANNED',
    });
  }

  // Accounts created before Personal projects existed get theirs on next login.
  await ensurePersonalProject(user._id);

  const userResponse = user.toObject();
  delete userResponse.password;

  const token = jwt.sign(
    { id: user._id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  return res.json({ message: 'Login successful', token, user: userResponse });
});

router.get('/me', auth, async (req, res) => {
  const user = await User.findById(req.userId).select('-password');
  if (!user) return res.status(404).json({ message: 'User not found' });
  return res.json({ user });
});

module.exports = router;
