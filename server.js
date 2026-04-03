const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'autodialer.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: UPLOAD_DIR });

const phoneConnections = new Map(); // phoneId -> socketId
const phoneDialerState = new Map(); // phoneId -> { running, paused }
const socketToPhone = new Map();    // socketId -> phoneId

let db;

function dbRun(sql, params = []) { db.run(sql, params); }
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql); stmt.bind(params);
  if (stmt.step()) {
    const cols = stmt.getColumnNames(), vals = stmt.get(); stmt.free();
    const row = {}; cols.forEach((c, i) => row[c] = vals[i]); return row;
  }
  stmt.free(); return null;
}
function dbAll(sql, params = []) {
  const stmt = db.prepare(sql); stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    const cols = stmt.getColumnNames(), vals = stmt.get();
    const row = {}; cols.forEach((c, i) => row[c] = vals[i]); rows.push(row);
  }
  stmt.free(); return rows;
}
function saveDb() {
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch (e) { console.error('DB save error:', e); }
}

async function main() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS sheets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, filename TEXT, row_count INTEGER DEFAULT 0,
    uploaded_at TEXT DEFAULT (datetime('now')), status TEXT DEFAULT 'active')`);
  db.run(`CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sheet_id TEXT REFERENCES sheets(id),
    name TEXT NOT NULL, phone TEXT NOT NULL, row_index INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS phones (
    id TEXT PRIMARY KEY, pairing_code TEXT, auth_token TEXT, nickname TEXT NOT NULL,
    status TEXT DEFAULT 'offline', battery_level INTEGER, signal_strength INTEGER,
    registered_at TEXT DEFAULT (datetime('now')), last_seen TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, phone_id TEXT REFERENCES phones(id),
    sheet_id TEXT REFERENCES sheets(id), lead_id INTEGER REFERENCES leads(id),
    call_status TEXT DEFAULT 'pending', call_duration INTEGER DEFAULT 0,
    attempts INTEGER DEFAULT 0, notes TEXT,
    assigned_at TEXT DEFAULT (datetime('now')), called_at TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

  // Migrate: add auth_token column if missing
  try { db.run('ALTER TABLE phones ADD COLUMN auth_token TEXT'); } catch (e) { /* already exists */ }

  // Seed defaults
  const defaultSettings = {
    pre_call_delay: '1', call_gap: '5', max_retries: '2',
    work_hours_start: '09:00', work_hours_end: '20:00', work_hours_enabled: 'false',
    auto_assign_phone_id: ''
  };
  for (const [k, v] of Object.entries(defaultSettings)) {
    if (!dbGet('SELECT key FROM settings WHERE key = ?', [k]))
      dbRun('INSERT INTO settings (key, value) VALUES (?, ?)', [k, v]);
  }

  // Seed admin
  if (!dbGet('SELECT id FROM users WHERE username = ?', ['admin'])) {
    dbRun('INSERT INTO users (username, password_hash) VALUES (?, ?)', ['admin', bcrypt.hashSync('admin123', 10)]);
  }
  saveDb();
  setInterval(saveDb, 10000);

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' }, pingTimeout: 60000, pingInterval: 25000 });

  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  function getSettings() {
    const rows = dbAll('SELECT key, value FROM settings');
    const s = {}; rows.forEach(r => s[r.key] = r.value); return s;
  }

  function sendQueueToPhone(phoneId) {
    const socketId = phoneConnections.get(phoneId);
    if (!socketId) return;
    const queue = dbAll(`SELECT a.id, l.name as lead_name, l.phone as lead_phone, a.call_status
      FROM assignments a JOIN leads l ON a.lead_id = l.id
      WHERE a.phone_id = ? AND a.call_status = 'pending' ORDER BY a.id`, [phoneId]);
    io.to(socketId).emit('server:queue-updated', { queue });
  }

  function autoAssignSheet(sheetId) {
    const setting = dbGet("SELECT value FROM settings WHERE key = 'auto_assign_phone_id'");
    if (!setting?.value) return;
    const phoneId = setting.value;
    const phone = dbGet('SELECT id FROM phones WHERE id = ?', [phoneId]);
    if (!phone) return;

    const leads = dbAll('SELECT * FROM leads WHERE sheet_id = ? ORDER BY row_index', [sheetId]);
    let assigned = 0;
    for (const lead of leads) {
      const exists = dbGet('SELECT id FROM assignments WHERE phone_id = ? AND lead_id = ?', [phoneId, lead.id]);
      if (!exists) {
        dbRun('INSERT INTO assignments (phone_id, sheet_id, lead_id) VALUES (?, ?, ?)', [phoneId, sheetId, lead.id]);
        assigned++;
      }
    }
    if (assigned > 0) {
      saveDb();
      sendQueueToPhone(phoneId);
      io.emit('server:assignments-changed');
      console.log(`Auto-assigned ${assigned} leads from sheet ${sheetId} to phone ${phoneId}`);
    }
    return assigned;
  }

  // --- REST ROUTES ---

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = dbGet('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ success: true, username: user.username });
  });

  // Sheets
  app.get('/api/sheets', (req, res) => {
    res.json(dbAll("SELECT * FROM sheets WHERE status = 'active' ORDER BY uploaded_at DESC"));
  });

  app.post('/api/sheets/upload', upload.single('file'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const wb = XLSX.readFile(req.file.path);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (data.length === 0) return res.status(400).json({ error: 'Empty sheet' });

      const headers = Object.keys(data[0]);
      let nameCol = headers.find(h => /^(name|lead.?name|full.?name|contact)$/i.test(h));
      let phoneCol = headers.find(h => /^(phone|lead.?phone|mobile|number|tel|telephone|cell)$/i.test(h));
      if (!nameCol) nameCol = headers[0];
      if (!phoneCol) phoneCol = headers.length > 1 ? headers[1] : headers[0];

      const sheetId = uuidv4();
      const sheetName = req.file.originalname.replace(/\.[^.]+$/, '');
      const seen = new Set();
      let dupes = 0, invalid = 0, inserted = 0;

      for (let i = 0; i < data.length; i++) {
        const rawName = String(data[i][nameCol] || '').trim();
        const rawPhone = String(data[i][phoneCol] || '').replace(/[^0-9+]/g, '');
        const digits = rawPhone.replace(/\D/g, '');
        if (digits.length < 7 || digits.length > 15) { invalid++; continue; }
        if (seen.has(digits)) { dupes++; continue; }
        seen.add(digits);
        dbRun('INSERT INTO leads (sheet_id, name, phone, row_index) VALUES (?, ?, ?, ?)',
          [sheetId, rawName || 'Unknown', rawPhone, i]);
        inserted++;
      }

      dbRun('INSERT INTO sheets (id, name, filename, row_count) VALUES (?, ?, ?, ?)',
        [sheetId, sheetName, req.file.originalname, inserted]);
      saveDb();
      try { fs.unlinkSync(req.file.path); } catch (e) {}

      // Assign to selected phones (from upload form) or auto-assign
      let totalAssigned = 0;
      let phonesAssigned = 0;
      const phoneIdsRaw = req.body?.phone_ids;
      const uploadMode = req.body?.mode || 'round-robin';

      if (phoneIdsRaw) {
        try {
          const phoneIds = JSON.parse(phoneIdsRaw);
          if (Array.isArray(phoneIds) && phoneIds.length > 0) {
            const allLeads = dbAll('SELECT * FROM leads WHERE sheet_id = ? ORDER BY row_index', [sheetId]);
            if (uploadMode === 'all-to-each') {
              for (const pid of phoneIds) {
                for (const lead of allLeads) {
                  if (!dbGet('SELECT id FROM assignments WHERE phone_id = ? AND lead_id = ?', [pid, lead.id])) {
                    dbRun('INSERT INTO assignments (phone_id, sheet_id, lead_id) VALUES (?, ?, ?)', [pid, sheetId, lead.id]);
                    totalAssigned++;
                  }
                }
              }
            } else {
              for (let i = 0; i < allLeads.length; i++) {
                const pid = phoneIds[i % phoneIds.length];
                if (!dbGet('SELECT id FROM assignments WHERE phone_id = ? AND lead_id = ?', [pid, allLeads[i].id])) {
                  dbRun('INSERT INTO assignments (phone_id, sheet_id, lead_id) VALUES (?, ?, ?)', [pid, sheetId, allLeads[i].id]);
                  totalAssigned++;
                }
              }
            }
            phonesAssigned = phoneIds.length;
            saveDb();
            io.emit('server:assignments-changed');
            for (const pid of phoneIds) sendQueueToPhone(pid);
            console.log(`Upload-assigned ${totalAssigned} leads from sheet ${sheetId} to ${phoneIds.length} phones`);
          }
        } catch (e) { console.error('Phone assignment parse error:', e); }
      }

      // Fallback: auto-assign if no phones were selected during upload
      if (totalAssigned === 0) {
        const autoAssigned = autoAssignSheet(sheetId);
        totalAssigned = autoAssigned || 0;
        if (totalAssigned > 0) phonesAssigned = 1;
      }

      res.json({
        sheet: { id: sheetId, name: sheetName, row_count: inserted,
          duplicates_removed: dupes, invalid_rows: invalid,
          detected_columns: { name: nameCol, phone: phoneCol },
          assigned: totalAssigned, phones_assigned: phonesAssigned }
      });
    } catch (e) {
      console.error('Upload error:', e);
      res.status(500).json({ error: 'Failed to process file' });
    }
  });

  app.get('/api/sheets/:id/leads', (req, res) => {
    res.json(dbAll('SELECT * FROM leads WHERE sheet_id = ? ORDER BY row_index', [req.params.id]));
  });

  app.delete('/api/sheets/:id', (req, res) => {
    dbRun("UPDATE sheets SET status = 'deleted' WHERE id = ?", [req.params.id]);
    saveDb(); res.json({ success: true });
  });

  // Phones
  app.get('/api/phones', (req, res) => {
    const phones = dbAll('SELECT * FROM phones ORDER BY registered_at DESC');
    phones.forEach(p => {
      p.connected = phoneConnections.has(p.id);
      const state = phoneDialerState.get(p.id);
      p.dialer_running = state?.running || false;
      p.dialer_paused = state?.paused || false;
      const stats = dbGet(`SELECT COUNT(*) as total,
        SUM(CASE WHEN call_status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN call_status = 'connected' THEN 1 ELSE 0 END) as connected,
        SUM(CASE WHEN call_status = 'no_answer' THEN 1 ELSE 0 END) as no_answer
        FROM assignments WHERE phone_id = ?`, [p.id]);
      p.stats = stats || { total: 0, pending: 0, connected: 0, no_answer: 0 };
    });
    res.json(phones);
  });

  app.post('/api/phones/register', (req, res) => {
    const count = dbGet('SELECT COUNT(*) as c FROM phones');
    if (count && count.c >= 10) return res.status(400).json({ error: 'Max 10 phones' });
    const { nickname } = req.body;
    const id = uuidv4();
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const authToken = uuidv4();
    const name = nickname || `Phone ${(count?.c || 0) + 1}`;
    dbRun('INSERT INTO phones (id, pairing_code, auth_token, nickname) VALUES (?, ?, ?, ?)',
      [id, code, authToken, name]);
    saveDb();
    res.json({ id, pairing_code: code, nickname: name });
  });

  app.put('/api/phones/:id/nickname', (req, res) => {
    dbRun('UPDATE phones SET nickname = ? WHERE id = ?', [req.body.nickname, req.params.id]);
    saveDb(); res.json({ success: true });
  });

  app.delete('/api/phones/:id', (req, res) => {
    const phoneId = req.params.id;
    dbRun("DELETE FROM assignments WHERE phone_id = ? AND call_status = 'pending'", [phoneId]);
    dbRun('DELETE FROM phones WHERE id = ?', [phoneId]);
    saveDb();
    const socketId = phoneConnections.get(phoneId);
    if (socketId) io.to(socketId).emit('server:deregistered');
    phoneConnections.delete(phoneId); phoneDialerState.delete(phoneId);
    res.json({ success: true });
  });

  // Assignments
  app.post('/api/assign', (req, res) => {
    const { sheet_id, phone_ids, mode } = req.body;
    if (!sheet_id || !phone_ids?.length) return res.status(400).json({ error: 'Missing params' });
    const leads = dbAll('SELECT * FROM leads WHERE sheet_id = ? ORDER BY row_index', [sheet_id]);
    if (leads.length === 0) return res.status(400).json({ error: 'No leads in sheet' });

    let assigned = 0;
    if (mode === 'all-to-each') {
      for (const pid of phone_ids) {
        for (const lead of leads) {
          if (!dbGet('SELECT id FROM assignments WHERE phone_id = ? AND lead_id = ?', [pid, lead.id])) {
            dbRun('INSERT INTO assignments (phone_id, sheet_id, lead_id) VALUES (?, ?, ?)', [pid, sheet_id, lead.id]);
            assigned++;
          }
        }
      }
    } else {
      for (let i = 0; i < leads.length; i++) {
        const pid = phone_ids[i % phone_ids.length];
        if (!dbGet('SELECT id FROM assignments WHERE phone_id = ? AND lead_id = ?', [pid, leads[i].id])) {
          dbRun('INSERT INTO assignments (phone_id, sheet_id, lead_id) VALUES (?, ?, ?)', [pid, sheet_id, leads[i].id]);
          assigned++;
        }
      }
    }
    saveDb(); io.emit('server:assignments-changed');
    for (const pid of phone_ids) sendQueueToPhone(pid);
    res.json({ success: true, assigned });
  });

  app.get('/api/phones/:id/assignments', (req, res) => {
    const all = req.query.all === 'true';
    const where = all ? '' : "AND a.call_status = 'pending'";
    res.json(dbAll(`SELECT a.*, l.name as lead_name, l.phone as lead_phone
      FROM assignments a JOIN leads l ON a.lead_id = l.id
      WHERE a.phone_id = ? ${where} ORDER BY a.id`, [req.params.id]));
  });

  // Phone self-service: get own queue (for phone app HTTP polling)
  app.get('/api/phones/:id/queue', (req, res) => {
    const queue = dbAll(`SELECT a.id, l.name as lead_name, l.phone as lead_phone, a.call_status,
      s.name as sheet_name FROM assignments a JOIN leads l ON a.lead_id = l.id
      JOIN sheets s ON a.sheet_id = s.id
      WHERE a.phone_id = ? AND a.call_status = 'pending' ORDER BY a.id`, [req.params.id]);
    // Group by sheet
    const sheets = {};
    queue.forEach(q => {
      if (!sheets[q.sheet_name]) sheets[q.sheet_name] = { name: q.sheet_name, count: 0, leads: [] };
      sheets[q.sheet_name].count++;
      sheets[q.sheet_name].leads.push(q);
    });
    res.json({ total: queue.length, queue, sheets: Object.values(sheets) });
  });

  app.get('/api/sheets/:id/assignments', (req, res) => {
    res.json(dbAll(`SELECT a.*, l.name as lead_name, l.phone as lead_phone, p.nickname as phone_name
      FROM assignments a JOIN leads l ON a.lead_id = l.id JOIN phones p ON a.phone_id = p.id
      WHERE a.sheet_id = ? ORDER BY a.id`, [req.params.id]));
  });

  // Dashboard stats
  app.get('/api/dashboard', (req, res) => {
    const stats = dbGet(`SELECT COUNT(*) as total_leads,
      SUM(CASE WHEN call_status != 'pending' THEN 1 ELSE 0 END) as calls_made,
      SUM(CASE WHEN call_status = 'connected' THEN 1 ELSE 0 END) as connected,
      SUM(CASE WHEN call_status = 'no_answer' THEN 1 ELSE 0 END) as no_answer,
      SUM(CASE WHEN call_status = 'pending' THEN 1 ELSE 0 END) as remaining,
      SUM(call_duration) as total_duration FROM assignments`);
    const phones = dbAll('SELECT * FROM phones ORDER BY registered_at DESC');
    phones.forEach(p => {
      p.connected = phoneConnections.has(p.id);
      const state = phoneDialerState.get(p.id);
      p.dialer_running = state?.running || false;
      p.dialer_paused = state?.paused || false;
    });
    res.json({ stats: stats || {}, phones });
  });

  // Settings
  app.get('/api/settings', (req, res) => res.json(getSettings()));
  app.put('/api/settings', (req, res) => {
    for (const [k, v] of Object.entries(req.body))
      dbRun('UPDATE settings SET value = ? WHERE key = ?', [String(v), k]);
    saveDb();
    const settings = getSettings();
    for (const [, socketId] of phoneConnections) io.to(socketId).emit('server:settings-updated', settings);
    res.json(settings);
  });

  // Dial controls
  app.post('/api/phones/:id/dial/start', (req, res) => {
    const phoneId = req.params.id;
    const socketId = phoneConnections.get(phoneId);
    if (!socketId) return res.status(400).json({ error: 'Phone not connected' });
    const queue = dbAll(`SELECT a.id, l.name as lead_name, l.phone as lead_phone, a.call_status
      FROM assignments a JOIN leads l ON a.lead_id = l.id
      WHERE a.phone_id = ? AND a.call_status = 'pending' ORDER BY a.id`, [phoneId]);
    if (queue.length === 0) return res.status(400).json({ error: 'No pending leads' });
    const settings = getSettings();
    io.to(socketId).emit('server:dial-start', { queue, settings });
    dbRun("UPDATE phones SET status = 'dialing' WHERE id = ?", [phoneId]);
    saveDb();
    res.json({ success: true, queue_size: queue.length });
  });

  app.post('/api/phones/:id/dial/pause', (req, res) => {
    const sid = phoneConnections.get(req.params.id);
    if (!sid) return res.status(400).json({ error: 'Phone not connected' });
    io.to(sid).emit('server:dial-pause'); res.json({ success: true });
  });
  app.post('/api/phones/:id/dial/resume', (req, res) => {
    const sid = phoneConnections.get(req.params.id);
    if (!sid) return res.status(400).json({ error: 'Phone not connected' });
    io.to(sid).emit('server:dial-resume'); res.json({ success: true });
  });
  app.post('/api/phones/:id/dial/stop', (req, res) => {
    const sid = phoneConnections.get(req.params.id);
    if (!sid) return res.status(400).json({ error: 'Phone not connected' });
    io.to(sid).emit('server:dial-stop');
    dbRun("UPDATE phones SET status = 'online' WHERE id = ?", [req.params.id]);
    saveDb(); res.json({ success: true });
  });

  // Export
  app.get('/api/export/:date', (req, res) => {
    const rows = dbAll(`SELECT l.name, l.phone, a.call_status, a.call_duration, a.attempts, a.notes,
      a.called_at, p.nickname as phone_name FROM assignments a JOIN leads l ON a.lead_id = l.id
      JOIN phones p ON a.phone_id = p.id WHERE a.call_status != 'pending' AND date(a.called_at) = ?
      ORDER BY a.called_at DESC`, [req.params.date]);
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Call Log');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename=call-log-${req.params.date}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  });

  // --- SOCKET.IO ---
  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // First-time pairing
    socket.on('phone:pair', (data) => {
      const code = data?.pairing_code;
      if (!code) return socket.emit('server:pair-failed', { error: 'No pairing code' });
      const phone = dbGet('SELECT * FROM phones WHERE pairing_code = ?', [code]);
      if (!phone) return socket.emit('server:pair-failed', { error: 'Invalid pairing code' });

      phoneConnections.set(phone.id, socket.id);
      socketToPhone.set(socket.id, phone.id);
      dbRun("UPDATE phones SET status = 'online', last_seen = datetime('now') WHERE id = ?", [phone.id]);
      saveDb();

      const settings = getSettings();
      // Send auth_token so phone can reconnect without pairing code
      socket.emit('server:pair-success', {
        phone_id: phone.id, nickname: phone.nickname, auth_token: phone.auth_token, settings
      });
      io.emit('server:phone-status-changed', { phoneId: phone.id, status: 'online' });

      // Send pending queue
      sendQueueToPhone(phone.id);
      console.log(`Phone paired: ${phone.nickname} (${phone.id})`);
    });

    // Reconnect with saved token (persistent login)
    socket.on('phone:reconnect', (data) => {
      const { phone_id, auth_token } = data || {};
      if (!phone_id || !auth_token) return socket.emit('server:reconnect-failed', { error: 'Missing credentials' });

      const phone = dbGet('SELECT * FROM phones WHERE id = ? AND auth_token = ?', [phone_id, auth_token]);
      if (!phone) return socket.emit('server:reconnect-failed', { error: 'Invalid token' });

      phoneConnections.set(phone.id, socket.id);
      socketToPhone.set(socket.id, phone.id);
      dbRun("UPDATE phones SET status = 'online', last_seen = datetime('now') WHERE id = ?", [phone.id]);

      const settings = getSettings();
      const queue = dbAll(`SELECT a.id, l.name as lead_name, l.phone as lead_phone, a.call_status
        FROM assignments a JOIN leads l ON a.lead_id = l.id
        WHERE a.phone_id = ? AND a.call_status = 'pending' ORDER BY a.id`, [phone.id]);

      socket.emit('server:reconnect-success', {
        phone_id: phone.id, nickname: phone.nickname, settings, queue
      });
      io.emit('server:phone-status-changed', { phoneId: phone.id, status: 'online' });
      console.log(`Phone reconnected: ${phone.nickname} (${phone.id})`);
    });

    socket.on('phone:heartbeat', (data) => {
      const phoneId = socketToPhone.get(socket.id);
      if (!phoneId) return;
      dbRun("UPDATE phones SET battery_level = ?, signal_strength = ?, last_seen = datetime('now') WHERE id = ?",
        [data.battery_level, data.signal_strength, phoneId]);
    });

    socket.on('phone:call-result', (data) => {
      const phoneId = socketToPhone.get(socket.id);
      if (!phoneId || !data?.assignment_id) return;
      dbRun(`UPDATE assignments SET call_status = ?, call_duration = ?,
        attempts = attempts + 1, called_at = datetime('now') WHERE id = ?`,
        [data.status, data.duration || 0, data.assignment_id]);
      saveDb();
      io.emit('server:call-update', {
        assignment_id: data.assignment_id, phone_id: phoneId,
        status: data.status, duration: data.duration || 0 });
    });

    socket.on('phone:add-note', (data) => {
      if (!data?.assignment_id) return;
      dbRun('UPDATE assignments SET notes = ? WHERE id = ?', [data.notes, data.assignment_id]);
      saveDb();
    });

    socket.on('phone:dialer-state', (data) => {
      const phoneId = socketToPhone.get(socket.id);
      if (!phoneId) return;
      phoneDialerState.set(phoneId, { running: data.running, paused: data.paused });
      let status = 'online';
      if (data.running && !data.paused) status = 'dialing';
      else if (data.running && data.paused) status = 'paused';
      dbRun('UPDATE phones SET status = ? WHERE id = ?', [status, phoneId]);
      io.emit('server:dialer-state-changed', { phoneId, running: data.running, paused: data.paused });
    });

    socket.on('disconnect', () => {
      const phoneId = socketToPhone.get(socket.id);
      if (phoneId) {
        phoneConnections.delete(phoneId); phoneDialerState.delete(phoneId);
        socketToPhone.delete(socket.id);
        dbRun("UPDATE phones SET status = 'offline' WHERE id = ?", [phoneId]);
        io.emit('server:phone-status-changed', { phoneId, status: 'offline' });
        console.log(`Phone disconnected: ${phoneId}`);
      }
    });
  });

  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  server.listen(PORT, () => {
    const interfaces = os.networkInterfaces();
    let localIP = 'localhost';
    for (const iface of Object.values(interfaces)) {
      for (const alias of iface) {
        if (alias.family === 'IPv4' && !alias.internal) { localIP = alias.address; break; }
      }
    }
    console.log(`\n  AutoDialer Server running!`);
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Network: http://${localIP}:${PORT}\n`);
  });
}

main().catch(err => { console.error('Failed to start:', err); process.exit(1); });
