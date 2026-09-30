const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'biashara-secret-change-me';

let db, users, txs;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('biashara');
  users = db.collection('users');
  txs = db.collection('transactions');
  await users.createIndex({ email: 1 }, { unique: true });
  await users.createIndex({ phone: 1 }, { unique: true });
  console.log('MongoDB connected');
}

function normalizePhone(input) {
  let p = String(input || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  return p;
}

function sanitize(u) {
  if (!u) return null;
  return {
    id: u._id.toString(),
    name: u.name,
    email: u.email,
    phone: u.phone,
    balance: u.balance || 0,
    role: u.role || 'user',
    status: u.status || 'active',
    id_number: u.id_number || null,
  };
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function getUserById(id) {
  return users.findOne({ _id: new ObjectId(id) });
}

function makeRef() {
  return 'BB' + Date.now().toString().slice(-8) + Math.floor(Math.random() * 90 + 10);
}

app.post('/api/register', async (req, res) => {
  try {
    const { name, email, phone, password, idNumber } = req.body;
    if (!name || !email || !phone || !password)
      return res.status(400).json({ error: 'Missing fields' });

    const norm = normalizePhone(phone);
    const existing = await users.findOne({
      $or: [{ email: email.toLowerCase() }, { phone: norm }]
    });
    if (existing)
      return res.status(400).json({ error: 'Email or phone already registered' });

    const hash = await bcrypt.hash(password, 10);
    const result = await users.insertOne({
      name,
      email: email.toLowerCase(),
      phone: norm,
      password_hash: hash,
      balance: 0,
      role: 'user',
      status: 'active',
      id_number: idNumber || null,
      created_at: new Date(),
    });

    const user = await getUserById(result.insertedId);
    const token = jwt.sign({ userId: result.insertedId.toString() }, JWT_SECRET, { expiresIn: '90d' });
    res.json({ token, user: sanitize(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Missing email or password' });

    const user = await users.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ error: 'No account found' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    const token = jwt.sign({ userId: user._id.toString() }, JWT_SECRET, { expiresIn: '90d' });
    res.json({ token, user: sanitize(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const user = await getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: sanitize(user) });
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/wallet/txs', auth, async (req, res) => {
  try {
    const list = await txs.find({ user_id: req.userId })
      .sort({ created_at: -1 }).limit(100).toArray();
    const formatted = list.map(t => ({
      id: t._id.toString(),
      type: t.type,
      amount: t.amount,
      description: t.description,
      reference: t.reference,
      status: t.status,
      mpesa_receipt: t.mpesa_receipt || null,
      counterparty: t.counterparty || null,
      created_at: t.created_at,
    }));
    res.json({ txs: formatted });
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/wallet/deposit', auth, async (req, res) => {
  try {
    const amt = Number(req.body.amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    await users.updateOne({ _id: new ObjectId(req.userId) }, { $inc: { balance: amt } });
    await txs.insertOne({
      user_id: req.userId,
      type: 'deposit',
      amount: amt,
      description: 'Deposit via M-Pesa',
      reference: makeRef(),
      status: 'completed',
      created_at: new Date(),
    });

    const user = await getUserById(req.userId);
    res.json({ balance: user.balance });
  } catch (e) {
    res.status(500).json({ error: 'Deposit failed' });
  }
});

app.post('/api/wallet/withdraw', auth, async (req, res) => {
  try {
    const amt = Number(req.body.amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const user = await getUserById(req.userId);
    if (user.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });

    await users.updateOne({ _id: new ObjectId(req.userId) }, { $inc: { balance: -amt } });
    await txs.insertOne({
      user_id: req.userId,
      type: 'withdrawal',
      amount: amt,
      description: 'Withdrawal to M-Pesa',
      reference: makeRef(),
      status: 'completed',
      mpesa_receipt: 'QK' + Date.now().toString().slice(-8),
      created_at: new Date(),
    });

    const updated = await getUserById(req.userId);
    res.json({ balance: updated.balance });
  } catch (e) {
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

app.post('/api/wallet/transfer', auth, async (req, res) => {
  try {
    const { phone, amount, note } = req.body;
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const norm = normalizePhone(phone);
    const sender = await getUserById(req.userId);
    if (sender.phone === norm) return res.status(400).json({ error: "Can't send to self" });
    if (sender.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });

    const recipient = await users.findOne({ phone: norm });
    if (!recipient) return res.status(404).json({ error: 'Recipient not found' });

    await users.updateOne({ _id: new ObjectId(req.userId) }, { $inc: { balance: -amt } });
    await users.updateOne({ _id: recipient._id }, { $inc: { balance: amt } });

    await txs.insertOne({
      user_id: req.userId,
      type: 'transfer_out',
      amount: amt,
      description: `Sent to ${recipient.name}${note ? ' — ' + note : ''}`,
      reference: makeRef(),
      status: 'completed',
      counterparty: recipient.name,
      created_at: new Date(),
    });

    await txs.insertOne({
      user_id: recipient._id.toString(),
      type: 'transfer_in',
      amount: amt,
      description: `Received from ${sender.name}${note ? ' — ' + note : ''}`,
      reference: makeRef(),
      status: 'completed',
      counterparty: sender.name,
      created_at: new Date(),
    });

    const updated = await getUserById(req.userId);
    res.json({
      balance: updated.balance,
      recipient: { name: recipient.name, phone: recipient.phone },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Transfer failed' });
  }
});

app.get('/api/lookup/:phone', async (req, res) => {
  try {
    const norm = normalizePhone(req.params.phone);
    const user = await users.findOne({ phone: norm });
    if (!user) return res.json({ found: false });
    res.json({
      found: true,
      user: { name: user.name, phone: user.phone, status: user.status || 'active' },
    });
  } catch (e) {
    res.json({ found: false });
  }
});

app.get('/api/public/activity', async (req, res) => {
  try {
    const recent = await txs.find({ type: 'deposit' }).sort({ created_at: -1 }).limit(10).toArray();
    const items = [];
    for (const t of recent) {
      const u = await users.findOne({ _id: new ObjectId(t.user_id) });
      if (u) {
        const parts = (u.name || 'User').split(' ');
        const masked = parts[0] + ' ' + (parts[1] ? parts[1][0] + '.' : '');
        items.push({ name: masked, amount: t.amount, at: t.created_at });
      }
    }
    res.json({ items });
  } catch (e) {
    res.json({ items: [] });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Biashara backend is running' }));

connectDB().then(() => {
  app.listen(PORT, () => console.log('Server running on port ' + PORT));
}).catch(err => {
  console.error('DB connection failed:', err);
  process.exit(1);
});