const AuditLog = require('../models/auditLogModel');

// req.ip only reads X-Forwarded-For when TRUST_PROXY says a proxy sets it, so clients can't fake it.
function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

async function writeAudit(req, { action, targetType, targetId, metadata }) {
  try {
    const actorId = req.user?.id;
    const actorRole = req.user?.role;
    if (!actorId || !actorRole) return;

    await AuditLog.create({
      actor: actorId,
      actorRole,
      action,
      targetType,
      targetId,
      metadata: metadata || {},
      ip: getClientIp(req),
      userAgent: String(req.headers['user-agent'] || ''),
    });
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

module.exports = { writeAudit };
