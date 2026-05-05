// src/middleware/auth.js
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.xhr || req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login');
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    if (roles.includes(req.session.user.role)) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

function auditLog(db, userId, action, module_, recordId, details, ip) {
  try {
    db.prepare('INSERT INTO audit_log (user_id,action,module,record_id,details,ip) VALUES (?,?,?,?,?,?)')
      .run(userId, action, module_, String(recordId || ''), JSON.stringify(details || {}), ip || '');
  } catch (_) { /* non-fatal */ }
}

module.exports = { requireLogin, requireRole, auditLog };
