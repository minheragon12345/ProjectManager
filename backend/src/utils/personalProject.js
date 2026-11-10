const Project = require('../models/projectModel');

// Every user has one Personal project for standalone tasks.
async function ensurePersonalProject(userId) {
  const existing = await Project.findOne({ owner: userId, isPersonal: true, isDeleted: false });
  if (existing) return existing;
  return Project.create({
    name: 'Personal',
    description: 'Your personal workspace for standalone tasks.',
    owner: userId,
    members: [],
    status: 'active',
    budget: { amount: 0, currency: 'USD', type: 'hourly' },
    isPersonal: true,
  });
}

module.exports = { ensurePersonalProject };
