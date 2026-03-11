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

const PASSWORD = process.env.PASSWORD || 'monmotdepasse';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('❌ DATABASE_URL manquante.'); process.exit(1); }

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
      message_sent BOOLEAN DEFAULT FALSE,
      wa_status TEXT DEFAULT 'unknown',
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
      time_slots JSONB DEFAULT '[]',
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
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      contact_number TEXT NOT NULL,
      contact_name TEXT,
      direction TEXT NOT NULL,
      message TEXT NOT NULL,
      received_at TIMESTAMPTZ DEFAULT NOW()
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
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS message_sent BOOLEAN DEFAULT FALSE;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_status TEXT DEFAULT 'unknown';
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS time_slots JSONB DEFAULT '[]';
  `);
  console.log('✅ Base de données prête');
}

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

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
class PgWAStore {
  async sessionExists({ session }) { return !!(await db.one('SELECT id FROM wa_session WHERE id=$1', [session])); }
  async save({ session, data }) {
    await db.run(`INSERT INTO wa_session(id,data,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(id) DO UPDATE SET data=$2,updated_at=NOW()`, [session, JSON.stringify(data)]);
  }
  async extract({ session }) { const r = await db.one('SELECT data FROM wa_session WHERE id=$1', [session]); return r ? JSON.parse(r.data) : null; }
  async delete({ session }) { await db.run('DELETE FROM wa_session WHERE id=$1', [session]); }
}

let waStatus = 'disconnected', currentQR = null, waClient = null;

function initWhatsApp() {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  waClient = new Client({
    authStrategy: new RemoteAuth({ store: new PgWAStore(), backupSyncIntervalMs: 300000 }),
    puppeteer: {
      headless: true, executablePath,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
             '--disable-accelerated-2d-canvas','--no-first-run','--no-zygote',
             '--single-process','--disable-gpu','--disable-extensions']
    }
  });

  waClient.on('qr', async qr => { waStatus = 'qr'; currentQR = await qrcode.toDataURL(qr); });
  waClient.on('ready', () => { waStatus = 'ready'; currentQR = null; console.log('✅ WhatsApp connecté'); });
  waClient.on('remote_session_saved', () => console.log('💾 Session sauvegardée'));
  waClient.on('auth_failure', () => { waStatus = 'disconnected'; });
  waClient.on('disconnected', () => { waStatus = 'disconnected'; });

  // Écoute les messages entrants
  waClient.on('message', async msg => {
    try {
      if (msg.from.includes('@g.us')) return; // ignore groupes
      const number = msg.from.replace('@c.us', '');
      const contact = await db.one('SELECT name FROM contacts WHERE number=$1', [number]);
      await db.run('INSERT INTO conversations(contact_number,contact_name,direction,message) VALUES($1,$2,$3,$4)',
        [number, contact?.name || number, 'in', msg.body]);
      console.log(`📩 Message reçu de ${number}`);
    } catch(e) { console.error('Erreur msg entrant:', e.message); }
  });

  waClient.initialize();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function renderMessage(template, contact) {
  let msg = template;
  const fields = { name: contact.name, number: contact.number, ...(contact.extra_fields || {}) };
  for (const [k, v] of Object.entries(fields)) msg = msg.replace(new RegExp(`{{${k}}}`, 'g'), v || '');
  return msg;
}

function parseCSV(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV vide');
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g,''));
  const numIdx = ['number','numero','numéro','phone','tel'].map(k => headers.indexOf(k)).find(i => i !== -1);
  const nameIdx = ['name','nom','prenom','prénom','firstname'].map(k => headers.indexOf(k)).find(i => i !== -1);
  if (numIdx === undefined) throw new Error('Colonne "number" introuvable');
  if (nameIdx === undefined) throw new Error('Colonne "name" introuvable');
  return lines.slice(1).map(line => {
    const cols = line.match(/(".*?"|[^,]+)(?=,|$)/g)?.map(c => c.replace(/^"|"$/g,'').trim()) || line.split(',').map(c=>c.trim());
    const extra = {};
    headers.forEach((h, i) => { if (i !== numIdx && i !== nameIdx) extra[h] = cols[i] || ''; });
    return { number: cols[numIdx]?.replace(/\D/g,''), name: cols[nameIdx], extra_fields: extra, headers: headers.filter((_,i) => i !== numIdx && i !== nameIdx) };
  }).filter(r => r.number && r.name);
}

// Distribue les messages sur plusieurs plages horaires
// slots = [{ start: "10:00", end: "12:00" }, ...]
function distributeAcrossSlots(slots, totalMessages, today) {
  const slotDurations = slots.map(s => {
    const [sh,sm] = s.start.split(':').map(Number);
    const [eh,em] = s.end.split(':').map(Number);
    return { startMin: sh*60+sm, endMin: eh*60+em, duration: (eh*60+em)-(sh*60+sm) };
  }).filter(s => s.duration > 0);

  if (!slotDurations.length) {
    const now = new Date(today);
    return Array.from({length: totalMessages}, (_, i) => new Date(now.getTime() + i*60000));
  }

  const totalDuration = slotDurations.reduce((a,s) => a + s.duration, 0);
  const times = [];

  for (const slot of slotDurations) {
    const slotMessages = Math.round((slot.duration / totalDuration) * totalMessages);
    if (!slotMessages) continue;
    const interval = slotMessages > 1 ? Math.floor(slot.duration / (slotMessages - 1)) : 0;
    for (let i = 0; i < slotMessages && times.length < totalMessages; i++) {
      const sendMin = slot.startMin + i * interval;
      const dt = new Date(today);
      dt.setHours(Math.floor(sendMin/60), sendMin%60, 0, 0);
      times.push(dt);
    }
  }

  // Complète si nécessaire
  while (times.length < totalMessages) times.push(times[times.length-1] || new Date(today));
  return times.slice(0, totalMessages);
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
      await db.run("UPDATE contacts SET message_sent=TRUE WHERE id=$1", [item.contact_id]);
      await db.run('INSERT INTO conversations(contact_number,contact_name,direction,message) VALUES($1,$2,$3,$4)', [item.number, item.name, 'out', msg]);
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

    const slots = camp.time_slots || [];
    let times;
    if (slots.length > 0 && camp.schedule_type === 'spread') {
      times = distributeAcrossSlots(slots, toSend.length, today);
    } else {
      const [h,m] = (camp.schedule_time||'09:00').split(':');
      const dt = new Date(today); dt.setHours(+h,+m,0,0);
      times = toSend.map(() => dt);
    }

    for (let i=0; i<toSend.length; i++) {
      await db.run('INSERT INTO send_queue(campaign_id,contact_id,scheduled_for) VALUES($1,$2,$3)', [camp.id, toSend[i].contact_id, times[i].toISOString()]);
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

app.get('/api/wa/status', requireAuth, (req, res) => res.json({ status: waStatus, qr: currentQR }));
app.post('/api/wa/disconnect', requireAuth, async (req, res) => {
  if (waClient) await waClient.destroy(); waStatus = 'disconnected'; res.json({ ok: true });
});
app.post('/api/wa/reconnect', requireAuth, (req, res) => {
  if (waClient) waClient.destroy(); setTimeout(initWhatsApp, 1000); res.json({ ok: true });
});

// ─── Vérification WhatsApp en masse ──────────────────────────────────────────
let verifyState = { running: false, total: 0, done: 0, found: 0, notFound: 0, errors: 0 };

app.get('/api/verify/status', requireAuth, (req, res) => res.json(verifyState));

app.post('/api/verify/start', requireAuth, async (req, res) => {
  if (verifyState.running) return res.status(400).json({ error: 'Vérification déjà en cours' });
  if (waStatus !== 'ready') return res.status(400).json({ error: 'WhatsApp non connecté' });

  const contacts = await db.all("SELECT id, number FROM contacts WHERE wa_status = 'unknown' ORDER BY id");
  if (!contacts.length) return res.status(400).json({ error: 'Tous les contacts ont déjà été vérifiés' });

  verifyState = { running: true, total: contacts.length, done: 0, found: 0, notFound: 0, errors: 0 };
  res.json({ ok: true, total: contacts.length });

  // Lance en arrière-plan
  (async () => {
    for (const contact of contacts) {
      if (!verifyState.running) break;
      try {
        const isWA = await waClient.isRegisteredUser(contact.number + '@c.us');
        const status = isWA ? 'on_whatsapp' : 'not_on_whatsapp';
        await db.run('UPDATE contacts SET wa_status= WHERE id=', [status, contact.id]);
        if (isWA) verifyState.found++; else verifyState.notFound++;
      } catch(e) {
        verifyState.errors++;
        console.error('Verify error:', contact.number, e.message);
      }
      verifyState.done++;
      // Délai aléatoire 1.5-3s pour ne pas déclencher les filtres anti-spam
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1500) + 1500));
    }
    verifyState.running = false;
    console.log(`✅ Vérification terminée: ${verifyState.found} WA, ${verifyState.notFound} non-WA, ${verifyState.errors} erreurs`);
  })();
});

app.post('/api/verify/stop', requireAuth, (req, res) => {
  verifyState.running = false;
  res.json({ ok: true });
});

app.post('/api/verify/reset', requireAuth, async (req, res) => {
  await db.run("UPDATE contacts SET wa_status='unknown'");
  verifyState = { running: false, total: 0, done: 0, found: 0, notFound: 0, errors: 0 };
  res.json({ ok: true });
});

// Contacts
app.get('/api/contacts', requireAuth, async (req, res) => res.json(await db.all('SELECT * FROM contacts ORDER BY created_at DESC')));
app.post('/api/contacts', requireAuth, async (req, res) => {
  const { name, number, extra_fields } = req.body;
  try {
    const r = await db.one('INSERT INTO contacts(name,number,extra_fields) VALUES($1,$2,$3) RETURNING id', [name, number.replace(/\D/g,''), JSON.stringify(extra_fields||{})]);
    res.json({ id: r.id });
  } catch { res.status(400).json({ error: 'Numéro déjà existant' }); }
});
app.delete('/api/contacts/all', requireAuth, async (req, res) => {
  await db.run('DELETE FROM contacts'); res.json({ ok: true });
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

// Export CSV avec statut message_sent + wa_status
app.get('/api/contacts/export', requireAuth, async (req, res) => {
  const contacts = await db.all('SELECT * FROM contacts ORDER BY name');
  const extraKeys = [...new Set(contacts.flatMap(c => Object.keys(c.extra_fields || {})))];
  const header = ['name','number','sur_whatsapp','statut_envoi', ...extraKeys].join(',');
  const rows = contacts.map(c => {
    const waStr = c.wa_status === 'on_whatsapp' ? 'oui' : c.wa_status === 'not_on_whatsapp' ? 'non' : 'inconnu';
    const base = [`"${c.name}"`, c.number, waStr, c.message_sent ? 'message envoyé' : 'non contacté'];
    const extras = extraKeys.map(k => `"${(c.extra_fields||{})[k] || ''}"`);
    return [...base, ...extras].join(',');
  });
  const csv = [header, ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts_statut.csv"');
  res.send('\uFEFF' + csv);
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
  const { name,message,schedule_type,schedule_time,schedule_days,daily_limit,time_slots,contact_ids } = req.body;
  const r = await db.one(
    `INSERT INTO campaigns(name,message,schedule_type,schedule_time,schedule_days,daily_limit,time_slots) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [name,message,schedule_type||'manual',schedule_time||'09:00',schedule_days||'1111111',daily_limit||10,JSON.stringify(time_slots||[])]
  );
  if (contact_ids?.length) for (const id of contact_ids)
    await db.run('INSERT INTO campaign_contacts(campaign_id,contact_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[r.id,id]);
  res.json({ id: r.id });
});

app.patch('/api/campaigns/:id', requireAuth, async (req, res) => {
  const { contact_ids, time_slots, ...fields } = req.body;
  const id = req.params.id;
  const allowed = ['name','message','status','schedule_type','schedule_time','schedule_days','daily_limit'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (time_slots !== undefined) updates.push(['time_slots', JSON.stringify(time_slots)]);
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

  let times;
  const slots = camp.time_slots || [];
  if (slots.length > 0 && camp.schedule_type === 'spread') {
    times = distributeAcrossSlots(slots, contacts.length, new Date());
  } else {
    const now = new Date();
    times = contacts.map((_,i) => new Date(now.getTime() + i*60000));
  }

  for (let i=0; i<contacts.length; i++)
    await db.run('INSERT INTO send_queue(campaign_id,contact_id,scheduled_for) VALUES($1,$2,$3)',[camp.id,contacts[i].id,times[i].toISOString()]);
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

// Conversations
app.get('/api/conversations', requireAuth, async (req, res) => {
  const convs = await db.all(`
    SELECT DISTINCT ON (contact_number) contact_number, contact_name, direction, message, received_at
    FROM conversations ORDER BY contact_number, received_at DESC
  `);
  const withMeta = await Promise.all(convs.map(async c => {
    const unread = await db.one("SELECT COUNT(*) n FROM conversations WHERE contact_number=$1 AND direction='in'", [c.contact_number]);
    return { ...c, unread: +unread.n };
  }));
  res.json(withMeta.sort((a,b) => new Date(b.received_at) - new Date(a.received_at)));
});

app.get('/api/conversations/:number', requireAuth, async (req, res) => {
  res.json(await db.all('SELECT * FROM conversations WHERE contact_number=$1 ORDER BY received_at ASC', [req.params.number]));
});

app.post('/api/conversations/:number/send', requireAuth, async (req, res) => {
  const { message } = req.body;
  const number = req.params.number;
  if (!message?.trim()) return res.status(400).json({ error: 'Message vide' });
  if (waStatus !== 'ready') return res.status(400).json({ error: 'WhatsApp non connecté' });
  try {
    await waClient.sendMessage(`${number}@c.us`, message);
    const contact = await db.one('SELECT name FROM contacts WHERE number=$1', [number]);
    await db.run('INSERT INTO conversations(contact_number,contact_name,direction,message) VALUES($1,$2,$3,$4)', [number, contact?.name || number, 'out', message]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
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
  const [total,errors,pending,today,byDay,byCampaign,replies] = await Promise.all([
    db.one("SELECT COUNT(*) n FROM send_queue WHERE status='sent'"),
    db.one("SELECT COUNT(*) n FROM send_queue WHERE status='error'"),
    db.one("SELECT COUNT(*) n FROM send_queue WHERE status='pending'"),
    db.one("SELECT COUNT(*) n FROM send_queue WHERE status='sent' AND sent_at::date=CURRENT_DATE"),
    db.all("SELECT sent_at::date day,COUNT(*) count FROM send_queue WHERE status='sent' GROUP BY sent_at::date ORDER BY day DESC LIMIT 14"),
    db.all("SELECT c.name,COUNT(*) sent FROM send_queue q JOIN campaigns c ON c.id=q.campaign_id WHERE q.status='sent' GROUP BY q.campaign_id,c.name ORDER BY sent DESC LIMIT 5"),
    db.one("SELECT COUNT(*) n FROM conversations WHERE direction='in'")
  ]);
  res.json({ total:+total.n, errors:+errors.n, pending:+pending.n, today:+today.n, byDay, byCampaign, replies:+replies.n });
});

async function start() {
  await initDB();
  initWhatsApp();
  app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT} — pwd: ${PASSWORD}`));
}
start().catch(err => { console.error(err); process.exit(1); });
