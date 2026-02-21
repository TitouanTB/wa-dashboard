const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Client, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cron = require('node-cron');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// ─── Config ───────────────────────────────────────────────────────────────────
const PASSWORD = process.env.PASSWORD || 'monmotdepasse';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL manquante.');
  process.exit(1);
}

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const db = {
  one:  async (text, p) => { const r = await pool.query(text, p); return r.rows[0] || null; },
  all:  async (text, p) => { const r = await pool.query(text, p); return r.rows; },
  run:  async (text, p) => pool.query(text, p)
};

async function initDB() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      number TEXT NOT NULL UNIQUE,
      extra_fields JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      schedule_type TEXT DEFAULT 'manual',
      schedule_time TEXT DEFAULT '09:00',
      schedule_days TEXT DEFAULT '1111111',
      daily_limit INTEGER DEFAULT 10,
      spread_over_day BOOLEAN DEFAULT FALSE,
      spread_start TEXT DEFAULT '09:00',
      spread_end TEXT DEFAULT '18:00',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS campaign_contacts (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      sent_at TIMESTAMPTZ,
      error TEXT,
      UNIQUE(campaign_id, contact_id)
    );
    CREATE TABLE IF NOT EXISTS send_queue (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
      scheduled_for TIMESTAMPTZ,
      status TEXT DEFAULT 'pending',
      sent_at TIMESTAMPTZ,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS wa_session (
      id TEXT PRIMARY KEY,
      data TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS session (
      sid TEXT PRIMARY KEY,
      sess JSONB NOT NULL,
      expire TIMESTAMPTZ NOT NULL
    );
  `);
  console.log('✅ Base de données prête');
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new PgSession({ pool, tableName: 'session' }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static('public'));

const requireAuth = (req, res, next) => {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'Non authentifié' });
};

// ─── WhatsApp RemoteAuth → stockage PostgreSQL ────────────────────────────────
class PgWAStore {
  async sessionExists({ session }) {
    const r = await db.one('SELECT id FROM wa_session WHERE id=$1', [session]);
    return !!r;
  }
  async save({ session, data }) {
    await db.run(`
      INSERT INTO wa_session (id, data, updated_at) VALUES ($1,$2,NOW())
      ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=NOW()
    `, [session, JSON.stringify(data)]);
  }
  async extract({ session }) {
    const r = await db.one('SELECT data FROM wa_session WHERE id=$1', [session]);
    return r ? JSON.parse(r.data) : null;
  }
  async delete({ session }) {
    await db.run('DELETE FROM wa_session WHERE id=$1', [session]);
  }
}

let waStatus = 'disconnected', currentQR = null, waClient = null;

function initWhatsApp() {
  // Sur Railway, on utilise le Chromium installé via Nix (PUPPETEER_EXECUTABLE_PATH)
  // En local, Puppeteer utilise son propre Chrome téléchargé
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  waClient = new Client({
    authStrategy: new RemoteAuth({
      store: new PgWAStore(),
      backupSyncIntervalMs: 300000
    }),
    puppeteer: {
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--safebrowsing-disable-auto-update'
      ]
    }
  });

  waClient.on('qr', async qr => { waStatus = 'qr'; currentQR = await qrcode.toDataURL(qr); });
  waClient.on('ready', () => { waStatus = 'ready'; currentQR = null; console.log('✅ WhatsApp connecté'); });
  waClient.on('remote_session_saved', () => console.log('💾 Session sauvegardée en base'));
  waClient.on('auth_failure', () => { waStatus = 'disconnected'; });
  waClient.on('disconnected', () => { waStatus = 'disconnected'; });
  waClient.initialize();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function renderMessage(template, contact) {
  let msg = template;
  const fields = { name: contact.name, number: contact.number, ...(contact.extra_fields || {}) };
  for (const [k, v] of Object.entries(fields)) {
    msg = msg.replace(new RegExp(`{{${k}}}`, 'g'), v || '');
  }
  return msg;
}

function parseCSV(buffer) {
  const lines = buffer.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV vide');
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const numIdx = ['number','numero','numéro','phone','tel'].map(k => headers.indexOf(k)).find(i => i !== -1);
  const nameIdx = ['name','nom','prenom','prénom','firstname'].map(k => headers.indexOf(k)).find(i => i !== -1);
  if (numIdx === undefined) throw new Error('Colonne "number" introuvable');
  if (nameIdx === undefined) throw new Error('Colonne "name" introuvable');
  return lines.slice(1).map(line => {
    const cols = line.split(',').map(c => c.trim());
    const extra = {};
    headers.forEach((h, i) => { if (i !== numIdx && i !== nameIdx) extra[h] = cols[i] || ''; });
    return { number: cols[numIdx]?.replace(/\D/g,''), name: cols[nameIdx], extra_fields: extra, headers: headers.filter((_,i) => i !== numIdx && i !== nameIdx) };
  }).filter(r => r.number && r.name);
}

// ─── Cron envoi ───────────────────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const items = await db.all(`
    SELECT q.*, c.message, ct.name, ct.number, ct.extra_fields
    FROM send_queue q
    JOIN campaigns c ON c.id=q.campaign_id
    JOIN contacts ct ON ct.id=q.contact_id
    WHERE q.status='pending' AND q.scheduled_for<=NOW()
    ORDER BY q.scheduled_for ASC LIMIT 3
  `);
  for (const item of items) {
    if (waStatus !== 'ready') {
      await db.run("UPDATE send_queue SET status='error',error=$1 WHERE id=$2", ['WA non connecté', item.id]);
      continue;
    }
    try {
      const msg = renderMessage(item.message, item);
      await waClient.sendMessage(`${item.number}@c.us`, msg);
      await db.run("UPDATE send_queue SET status='sent',sent_at=NOW() WHERE id=$1", [item.id]);
      await db.run("UPDATE campaign_contacts SET status='sent',sent_at=NOW() WHERE campaign_id=$1 AND contact_id=$2", [item.campaign_id, item.contact_id]);
      console.log(`✅ Envoyé à ${item.name}`);
    } catch (err) {
      await db.run("UPDATE send_queue SET status='error',error=$1 WHERE id=$2", [err.message, item.id]);
      await db.run("UPDATE campaign_contacts SET status='error',error=$1 WHERE campaign_id=$2 AND contact_id=$3", [err.message, item.campaign_id, item.contact_id]);
    }
    await sleep(Math.floor(Math.random() * 30000) + 30000);
  }
});

cron.schedule('0 0 * * *', scheduleAllCampaigns);

async function scheduleAllCampaigns() {
  const camps = await db.all("SELECT * FROM campaigns WHERE status='active' AND schedule_type!='manual'");
  const today = new Date();
  const dayIdx = today.getDay();
  for (const camp of camps) {
    if ((camp.schedule_days || '1111111')[dayIdx] !== '1') continue;
    const pending = await db.all("SELECT contact_id FROM campaign_contacts WHERE campaign_id=$1 AND status='pending'", [camp.id]);
    const toSend = pending.slice(0, camp.daily_limit);
    if (!toSend.length) continue;
    if (camp.spread_over_day) {
      const [sh,sm] = camp.spread_start.split(':').map(Number);
      const [eh,em] = camp.spread_end.split(':').map(Number);
      const startMin = sh*60+sm, endMin = eh*60+em;
      const interval = Math.floor((endMin-startMin)/(toSend.length||1));
      for (let i=0; i<toSend.length; i++) {
        const sendMin = startMin+i*interval;
        const dt = new Date(today); dt.setHours(Math.floor(sendMin/60), sendMin%60, 0, 0);
        await db.run('INSERT INTO send_queue(campaign_id,contact_id,scheduled_for) VALUES($1,$2,$3)', [camp.id, toSend[i].contact_id, dt.toISOString()]);
      }
    } else {
      const [h,m] = (camp.schedule_time||'09:00').split(':');
      const dt = new Date(today); dt.setHours(+h,+m,0,0);
      for (const item of toSend) {
        await db.run('INSERT INTO send_queue(campaign_id,contact_id,scheduled_for) VALUES($1,$2,$3)', [camp.id, item.contact_id, dt.toISOString()]);
      }
    }
    await db.run("UPDATE campaigns SET status='running' WHERE id=$1", [camp.id]);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', (req, res) => {
  if (!req.session.authenticated) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/login', (req, res) => {
  if (req.body.password === PASSWORD) { req.session.authenticated = true; res.json({ ok: true }); }
  else res.status(401).json({ error: 'Mot de passe incorrect' });
});
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

// WA
app.get('/api/wa/status', requireAuth, (req, res) => res.json({ status: waStatus, qr: currentQR }));
app.post('/api/wa/disconnect', requireAuth, async (req, res) => {
  if (waClient) await waClient.destroy(); waStatus = 'disconnected'; res.json({ ok: true });
});
app.post('/api/wa/reconnect', requireAuth, (req, res) => {
  if (waClient) waClient.destroy();
  setTimeout(initWhatsApp, 1000);
  res.json({ ok: true });
});

// Contacts
app.get('/api/contacts', requireAuth, async (req, res) => res.json(await db.all('SELECT * FROM contacts ORDER BY created_at DESC')));

app.post('/api/contacts', requireAuth, async (req, res) => {
  const { name, number, extra_fields } = req.body;
  const clean = number.replace(/\D/g,'');
  try {
    const r = await db.one('INSERT INTO contacts(name,number,extra_fields) VALUES($1,$2,$3) RETURNING id', [name, clean, JSON.stringify(extra_fields||{})]);
    res.json({ id: r.id });
  } catch { res.status(400).json({ error: 'Numéro déjà existant' }); }
});

app.delete('/api/contacts/:id', requireAuth, async (req, res) => {
  await db.run('DELETE FROM contacts WHERE id=$1', [req.params.id]); res.json({ ok: true });
});

app.post('/api/contacts/import', requireAuth, upload.single('csv'), async (req, res) => {
  try {
    const rows = parseCSV(req.file.buffer);
    let imported = 0, skipped = 0;
    for (const row of rows) {
      const r = await db.run('INSERT INTO contacts(name,number,extra_fields) VALUES($1,$2,$3) ON CONFLICT(number) DO NOTHING', [row.name, row.number, JSON.stringify(row.extra_fields)]);
      r.rowCount ? imported++ : skipped++;
    }
    res.json({ imported, skipped, total: rows.length, headers: rows[0]?.headers || [] });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Campaigns
app.get('/api/campaigns', requireAuth, async (req, res) => {
  const camps = await db.all('SELECT * FROM campaigns ORDER BY created_at DESC');
  const result = await Promise.all(camps.map(async c => {
    const [total,sent,errors,pending] = await Promise.all([
      db.one('SELECT COUNT(*) n FROM campaign_contacts WHERE campaign_id=$1',[c.id]),
      db.one("SELECT COUNT(*) n FROM campaign_contacts WHERE campaign_id=$1 AND status='sent'",[c.id]),
      db.one("SELECT COUNT(*) n FROM campaign_contacts WHERE campaign_id=$1 AND status='error'",[c.id]),
      db.one("SELECT COUNT(*) n FROM campaign_contacts WHERE campaign_id=$1 AND status='pending'",[c.id])
    ]);
    return { ...c, total:+total.n, sent:+sent.n, errors:+errors.n, pending:+pending.n };
  }));
  res.json(result);
});

app.post('/api/campaigns', requireAuth, async (req, res) => {
  const { name,message,schedule_type,schedule_time,schedule_days,daily_limit,spread_over_day,spread_start,spread_end,contact_ids } = req.body;
  const r = await db.one(`INSERT INTO campaigns(name,message,schedule_type,schedule_time,schedule_days,daily_limit,spread_over_day,spread_start,spread_end)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [name,message,schedule_type||'manual',schedule_time||'09:00',schedule_days||'1111111',daily_limit||10,!!spread_over_day,spread_start||'09:00',spread_end||'18:00']);
  if (contact_ids?.length) for (const id of contact_ids)
    await db.run('INSERT INTO campaign_contacts(campaign_id,contact_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[r.id,id]);
  res.json({ id: r.id });
});

app.patch('/api/campaigns/:id', requireAuth, async (req, res) => {
  const { contact_ids, ...fields } = req.body;
  const id = req.params.id;
  const allowed = ['name','message','status','schedule_type','schedule_time','schedule_days','daily_limit','spread_over_day','spread_start','spread_end'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (updates.length) {
    const set = updates.map(([k],i) => `${k}=$${i+1}`).join(',');
    await db.run(`UPDATE campaigns SET ${set} WHERE id=$${updates.length+1}`, [...updates.map(([,v])=>v), id]);
  }
  if (contact_ids) {
    await db.run('DELETE FROM campaign_contacts WHERE campaign_id=$1',[id]);
    for (const cid of contact_ids)
      await db.run('INSERT INTO campaign_contacts(campaign_id,contact_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,cid]);
  }
  res.json({ ok: true });
});

app.post('/api/campaigns/:id/send-now', requireAuth, async (req, res) => {
  const camp = await db.one('SELECT * FROM campaigns WHERE id=$1',[req.params.id]);
  if (!camp) return res.status(404).json({ error: 'Introuvable' });
  const contacts = await db.all(`SELECT ct.* FROM contacts ct JOIN campaign_contacts cc ON cc.contact_id=ct.id WHERE cc.campaign_id=$1 AND cc.status='pending' LIMIT $2`,[camp.id,camp.daily_limit]);
  if (!contacts.length) return res.status(400).json({ error: 'Aucun contact en attente' });
  await db.run("UPDATE campaigns SET status='running' WHERE id=$1",[camp.id]);
  const now = new Date();
  for (let i=0; i<contacts.length; i++) {
    const sendAt = new Date(now.getTime() + i*60000);
    await db.run('INSERT INTO send_queue(campaign_id,contact_id,scheduled_for) VALUES($1,$2,$3)',[camp.id,contacts[i].id,sendAt.toISOString()]);
  }
  res.json({ ok:true, queued:contacts.length });
});

app.post('/api/campaigns/:id/activate', requireAuth, async (req, res) => {
  await db.run("UPDATE campaigns SET status='active' WHERE id=$1",[req.params.id]);
  scheduleAllCampaigns();
  res.json({ ok:true });
});

app.delete('/api/campaigns/:id', requireAuth, async (req, res) => {
  await db.run('DELETE FROM campaigns WHERE id=$1',[req.params.id]); res.json({ ok:true });
});

// Queue & Logs
app.get('/api/queue', requireAuth, async (req, res) => res.json(await db.all(`
  SELECT q.*,c.name campaign_name,ct.name contact_name,ct.number FROM send_queue q
  JOIN campaigns c ON c.id=q.campaign_id JOIN contacts ct ON ct.id=q.contact_id
  WHERE q.status='pending' ORDER BY q.scheduled_for ASC LIMIT 100
`)));

app.get('/api/logs', requireAuth, async (req, res) => res.json(await db.all(`
  SELECT q.*,c.name campaign_name,ct.name contact_name,ct.number FROM send_queue q
  JOIN campaigns c ON c.id=q.campaign_id JOIN contacts ct ON ct.id=q.contact_id
  WHERE q.status IN ('sent','error') ORDER BY q.sent_at DESC LIMIT 200
`)));

app.get('/api/analytics', requireAuth, async (req, res) => {
  const [total,errors,pending,today,byDay,byCampaign] = await Promise.all([
    db.one("SELECT COUNT(*) n FROM send_queue WHERE status='sent'"),
    db.one("SELECT COUNT(*) n FROM send_queue WHERE status='error'"),
    db.one("SELECT COUNT(*) n FROM send_queue WHERE status='pending'"),
    db.one("SELECT COUNT(*) n FROM send_queue WHERE status='sent' AND sent_at::date=CURRENT_DATE"),
    db.all("SELECT sent_at::date day,COUNT(*) count FROM send_queue WHERE status='sent' GROUP BY sent_at::date ORDER BY day DESC LIMIT 14"),
    db.all("SELECT c.name,COUNT(*) sent FROM send_queue q JOIN campaigns c ON c.id=q.campaign_id WHERE q.status='sent' GROUP BY q.campaign_id,c.name ORDER BY sent DESC LIMIT 5")
  ]);
  res.json({ total:+total.n, errors:+errors.n, pending:+pending.n, today:+today.n, byDay, byCampaign });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await initDB();
  initWhatsApp();
  app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT} — pwd: ${PASSWORD}`));
}
start().catch(err => { console.error(err); process.exit(1); });
