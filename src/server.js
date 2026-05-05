// src/server.js
// Suppress Node.js experimental SQLite warning (harmless, just noisy)
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && w.message.includes('SQLite')) return;
  console.warn(w.toString());
});

require('./db/setup'); // Run DB setup on first start
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const bcrypt = require('bcryptjs');
const path = require('path');
const os = require('os');
const { getDb } = require('./db/index');
const { requireLogin } = require('./middleware/auth');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'ipcmo-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));

app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', apiRoutes);

// Auth routes
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  db.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").run(user.id);
  req.session.user = { id: user.id, username: user.username, full_name: user.full_name, role: user.role, company: user.company, location: user.location };
  res.json({ ok: true, user: req.session.user });
});

app.post('/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/', requireLogin, (req, res) => res.sendFile(path.join(__dirname, '../public/app.html')));
app.get('/app*', requireLogin, (req, res) => res.sendFile(path.join(__dirname, '../public/app.html')));

// Start server
app.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) { localIP = addr.address; break; }
    }
  }
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  INTEGRATED PIPE CUTTING MANAGEMENT & OPTIMIZER (IPCMO) ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Local:   http://localhost:${PORT}                           ║`);
  console.log(`║  Network: http://${localIP}:${PORT}                     ║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  Default login: admin / Admin@1234                      ║');
  console.log('║  CHANGE PASSWORD AFTER FIRST LOGIN!                     ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
});
