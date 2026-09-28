const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-please-abc123';

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL env var');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      pin TEXT,
      role TEXT DEFAULT 'user',
      balance NUMERIC(15,2) DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS txs (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount NUMERIC(15,2) NOT NULL,
      status TEXT DEFAULT 'completed',
      reference TEXT,
      description TEXT,
      counterparty TEXT,
      mpesa_receipt TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB ready');
}
init().catch(e => console.error('init error', e));

function normalizePhone(p) {
  let s = String(p || '').replace(/[^\d+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0')) s = '254' + s.slice(1);
  if (s.startsWith('7') || s.startsWith('1')) s = '254' + s;
  return s;
}
function ref(prefix = 'TXN') {
  return `${prefix}${Date.now().toString().slice(-8)}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.userId = jwt.verify(token, JWT_SECRET).id; next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

app.get('/', (_, res) => res.json({ ok: true, service: 'kes-wallet' }));

app.post('/api/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password)
      return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const p = normalizePhone(phone);
    if (p.length !== 12) return res.status(400).json({ error: 'Invalid phone number' });

    const exists = await pool.query(
      'SELECT 1 FROM users WHERE LOWER(email)=LOWER($1) OR phone=$2',
      [email, p]
    );
    if (exists.rows.length) return res.status(400).json({ error: 'Email or phone already registered' });

    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO users (name,email,phone,password_hash) VALUES ($1,$2,$3,$4)
       RETURNING id,name,email,phone,balance,status,role`,
      [name, email, p, hash]
    );
    const user = r.rows[0];
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const r = await pool.query('SELECT * FROM users WHERE LOWER(email)=LOWER($1)', [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid email or password' });
    const u = r.rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: {
        id: u.id, name: u.name, email: u.email, phone: u.phone,
        balance: u.balance, status: u.status, role: u.role,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT id,name,email,phone,balance,status,role FROM users WHERE id=$1',
    [req.userId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ user: r.rows[0] });
});

app.get('/api/lookup/:phone', auth, async (req, res) => {
  const p = normalizePhone(req.params.phone);
  const r = await pool.query('SELECT id,name,phone,status FROM users WHERE phone=$1', [p]);
  if (!r.rows.length) return res.json({ found: false });
  res.json({ found: true, user: r.rows[0] });
});

app.get('/api/wallet/balance', auth, async (req, res) => {
  const r = await pool.query('SELECT balance FROM users WHERE id=$1', [req.userId]);
  res.json({ balance: r.rows[0].balance });
});

app.get('/api/wallet/txs', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM txs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
    [req.userId]
  );
  res.json({ txs: r.rows });
});

app.post('/api/wallet/deposit', auth, async (req, res) => {
  const amt = Number(req.body.amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET balance = balance + $1 WHERE id=$2', [amt, req.userId]);
    await client.query(
      `INSERT INTO txs (user_id,type,amount,status,reference,description,counterparty,mpesa_receipt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.userId, 'deposit', amt, 'completed', ref('DEP'), 'M-Pesa deposit', 'M-Pesa', ref('QK').slice(0, 10)]
    );
    await client.query('COMMIT');
    const r = await pool.query('SELECT balance FROM users WHERE id=$1', [req.userId]);
    res.json({ balance: r.rows[0].balance });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Deposit failed' });
  } finally {
    client.release();
  }
});

app.post('/api/wallet/withdraw', auth, async (req, res) => {
  const amt = Number(req.body.amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [req.userId]);
    if (Number(r.rows[0].balance) < amt) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    await client.query('UPDATE users SET balance = balance - $1 WHERE id=$2', [amt, req.userId]);
    await client.query(
      `INSERT INTO txs (user_id,type,amount,status,reference,description,counterparty,mpesa_receipt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.userId, 'withdrawal', amt, 'completed', ref('WDR'), 'Withdrawal to M-Pesa', 'M-Pesa', ref('QK').slice(0, 10)]
    );
    await client.query('COMMIT');
    const b = await pool.query('SELECT balance FROM users WHERE id=$1', [req.userId]);
    res.json({ balance: b.rows[0].balance });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Withdrawal failed' });
  } finally {
    client.release();
  }
});

app.post('/api/wallet/transfer', auth, async (req, res) => {
  const amt = Number(req.body.amount);
  const phone = normalizePhone(req.body.phone);
  const note = String(req.body.note || '').slice(0, 80);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const me = await client.query(
      'SELECT id,name,phone,balance,status FROM users WHERE id=$1 FOR UPDATE',
      [req.userId]
    );
    const sender = me.rows[0];
    if (sender.status !== 'active') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Your wallet is frozen' }); }
    if (sender.phone === phone) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cannot send to yourself' }); }
    if (Number(sender.balance) < amt) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient balance' }); }

    const rr = await client.query(
      'SELECT id,name,phone,status FROM users WHERE phone=$1 FOR UPDATE',
      [phone]
    );
    if (!rr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Recipient not found' }); }
    const recipient = rr.rows[0];
    if (recipient.status !== 'active') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Recipient wallet is frozen' }); }

    await client.query('UPDATE users SET balance = balance - $1 WHERE id=$2', [amt, sender.id]);
    await client.query('UPDATE users SET balance = balance + $1 WHERE id=$2', [amt, recipient.id]);
    await client.query(
      `INSERT INTO txs (user_id,type,amount,status,reference,description,counterparty)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [sender.id, 'transfer_out', amt, 'completed', ref('TRO'),
       `Sent to ${recipient.name}${note ? ' — ' + note : ''}`, recipient.phone]
    );
    await client.query(
      `INSERT INTO txs (user_id,type,amount,status,reference,description,counterparty)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [recipient.id, 'transfer_in', amt, 'completed', ref('TRI'),
       `Received from ${sender.name}${note ? ' — ' + note : ''}`, sender.phone]
    );
    await client.query('COMMIT');
    const b = await pool.query('SELECT balance FROM users WHERE id=$1', [sender.id]);
    res.json({
      balance: b.rows[0].balance,
      recipient: { name: recipient.name, phone: recipient.phone },
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Transfer failed' });
  } finally {
    client.release();
  }
});

app.get('/api/admin/users', auth, async (req, res) => {
  const me = await pool.query('SELECT role FROM users WHERE id=$1', [req.userId]);
  if (!me.rows.length || me.rows[0].role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  const r = await pool.query(
    'SELECT id,name,email,phone,balance,status,role FROM users ORDER BY created_at DESC'
  );
  res.json({ users: r.rows });
});

app.post('/api/admin/freeze/:id', auth, async (req, res) => {
  const me = await pool.query('SELECT role FROM users WHERE id=$1', [req.userId]);
  if (!me.rows.length || me.rows[0].role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  const { status } = req.body;
  const s = status === 'frozen' ? 'frozen' : 'active';
  await pool.query('UPDATE users SET status=$1 WHERE id=$2', [s, req.params.id]);
  res.json({ ok: true, status: s });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on port', PORT));