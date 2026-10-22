// Halston Estates booking backend. Zero dependencies, Node 20+. Run: node server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
try { // tiny .env loader
  for (const l of fs.readFileSync(path.join(__dir, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}
let { PORT = 4000, ADMIN_TOKEN = '', ALLOWED_ORIGIN = '*', RESEND_API_KEY = '', NOTIFY_EMAIL = '', FROM_EMAIL = '' } = process.env;
if (ADMIN_TOKEN.length < 12) { // beginner-friendly: create and remember an admin password automatically
  const TF = path.join(__dir, 'data', 'admin-token.txt'); fs.mkdirSync(path.dirname(TF), { recursive: true });
  try { ADMIN_TOKEN = fs.readFileSync(TF, 'utf8').trim(); } catch {}
  if (ADMIN_TOKEN.length < 12) { ADMIN_TOKEN = crypto.randomBytes(9).toString('hex'); fs.writeFileSync(TF, ADMIN_TOKEN); }
  console.log('\n  ADMIN PASSWORD (saved in data/admin-token.txt):', ADMIN_TOKEN, '\n');
}

const SLOTS = ['10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00'];
const STATUSES = ['pending', 'confirmed', 'cancelled'];
const DB = path.join(__dir, 'data', 'bookings.json');
fs.mkdirSync(path.dirname(DB), { recursive: true });
let bookings = []; try { bookings = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
const save = () => { const t = DB + '.tmp'; fs.writeFileSync(t, JSON.stringify(bookings, null, 2)); fs.renameSync(t, DB); };

const hits = new Map(); // ip -> timestamps, 5 bookings per hour
const limited = ip => { const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 36e5); hits.set(ip, a); if (a.length >= 5) return true; a.push(now); return false; };
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, max);
const isAdmin = req => { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); if (ADMIN_TOKEN.length < 12 || !t) return false;
  const a = Buffer.from(t), b = Buffer.from(ADMIN_TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); };

function send(res, code, obj, extra = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS', ...extra });
  res.end(JSON.stringify(obj));
}
const body = req => new Promise((ok, no) => { let s = ''; req.on('data', c => { s += c; if (s.length > 20000) { no(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { no(new Error('bad json')); } }); });
const taken = (date, time, skipId) => bookings.some(b => b.date === date && b.time === time && b.status !== 'cancelled' && b.id !== skipId);

async function notify(b) {
  if (!RESEND_API_KEY || !NOTIFY_EMAIL) return;
  try {
    await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to: [NOTIFY_EMAIL], subject: `New tour request ${b.reference}: ${b.property}`,
        text: `${b.name}\n${b.phone} ${b.email}\n${b.property}\n${b.date} ${b.time}\n\n${b.notes}` }) });
  } catch (e) { console.error('email failed', e.message); }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), ip = req.socket.remoteAddress;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dir, 'public', 'index.html'))); }
    if (url.pathname === '/admin' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(path.join(__dir, 'admin.html'))); }
    if (url.pathname === '/api/slots' && req.method === 'GET') {
      const d = url.searchParams.get('date') || '';
      return send(res, 200, { date: d, slots: SLOTS.map(t => ({ time: t, available: !taken(d, t) })) });
    }
    if (url.pathname === '/api/bookings' && req.method === 'POST') {
      if (limited(ip)) return send(res, 429, { error: 'Too many requests. Please try again later.' });
      const x = await body(req);
      if (x.website) return send(res, 201, { ok: true }); // honeypot: bots fill this, pretend success
      const b = { name: clean(x.name, 80), phone: clean(x.phone, 30), email: clean(x.email, 120), property: clean(x.property, 100),
        date: clean(x.date, 10), time: clean(x.time, 5), notes: clean(x.notes, 500) };
      const err = [];
      if (b.name.length < 2) err.push('Enter your name.');
      if (!/^\+?[0-9 ()-]{7,20}$/.test(b.phone)) err.push('Enter a valid phone number.');
      if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) err.push('Enter a valid email address.');
      if (!b.property) err.push('Choose a property.');
      const dt = new Date(b.date + 'T00:00:00'), today = new Date(); today.setHours(0, 0, 0, 0);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || isNaN(dt) || dt < today || dt - today > 365 * 864e5) err.push('Choose a date within the next year.');
      if (!SLOTS.includes(b.time)) err.push('Choose a time slot.');
      if (err.length) return send(res, 400, { error: err.join(' ') });
      if (taken(b.date, b.time)) return send(res, 409, { error: 'That time is already booked. Please choose another slot.' });
      Object.assign(b, { id: crypto.randomUUID(), reference: 'HE-' + crypto.randomBytes(3).toString('hex').toUpperCase(), status: 'pending', createdAt: new Date().toISOString() });
      bookings.push(b); save(); notify(b);
      return send(res, 201, { ok: true, reference: b.reference, message: 'Request received. An advisor will confirm shortly.' });
    }
    if (url.pathname === '/api/bookings' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Unauthorized' });
      return send(res, 200, { bookings: [...bookings].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)) });
    }
    const m = url.pathname.match(/^\/api\/bookings\/([\w-]+)$/);
    if (m && req.method === 'PATCH') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Unauthorized' });
      const b = bookings.find(v => v.id === m[1]); if (!b) return send(res, 404, { error: 'Not found' });
      const { status } = await body(req); if (!STATUSES.includes(status)) return send(res, 400, { error: 'Invalid status' });
      if (status !== 'cancelled' && taken(b.date, b.time, b.id)) return send(res, 409, { error: 'Slot taken by another booking' });
      b.status = status; save(); return send(res, 200, { ok: true, booking: b });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) { send(res, e.message === 'too large' ? 413 : 400, { error: 'Bad request' }); }
}).listen(PORT, () => console.log(`Website:  http://localhost:${PORT}\n  Bookings: http://localhost:${PORT}/admin`));
