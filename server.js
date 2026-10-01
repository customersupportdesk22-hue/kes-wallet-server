const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient, ObjectId } = require('mongodb');
const AfricasTalking = require('africastalking');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'biashara-secret-change-me';

const REFERRAL_BONUS = 50;

const AT_USERNAME = process.env.AT_USERNAME || 'biasharasms';
const AT_API_KEY = process.env.AT_API_KEY || '';
let atSms = null;
try {
  const at = AfricasTalking({ username: AT_USERNAME, apiKey: AT_API_KEY });
  atSms = at.SMS;
  console.log("Africa's Talking initialized");
} catch(e) {
  console.log('AT init failed:', e.message);
}

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '';
const ONESIGNAL_REST_KEY = process.env.ONESIGNAL_REST_KEY || '';

function normalizePhone(input) {
  let p = String(input || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  return p;
}

async function sendSMS(phone, message) {
  if (!atSms || !AT_API_KEY) {
    console.log('SMS skipped - AT not configured');
    return;
  }
  try {
    const to = '+' + normalizePhone(phone);
    console.log('Sending SMS to', to);
    const result = await atSms.send({ to: [to], message });
    console.log('SMS result:', JSON.stringify(result));
    return result;
  } catch(e) {
    console.error('SMS failed:', e.message);
  }
}

async function sendPush(phone, title, message) {
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_KEY) {
    console.log('Push skipped - OneSignal not configured');
    return;
  }
  try {
    const norm = normalizePhone(phone);
    const res = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + ONESIGNAL_REST_KEY
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_aliases: { external_id: [norm] },
        target_channel: 'push',
        headings: { en: title },
        contents: { en: message }
      })
    });
    const data = await res.json();
    console.log('Push result:', data.id || data.errors || data);
    return data;
  } catch(e) {
    console.error('Push failed:', e.message);
  }
}

async function notify(phone, title, message) {
  await Promise.allSettled([
    sendSMS(phone, message),
    sendPush(phone, title, message)
  ]);
}

let db, users, txs, loans;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('biashara');
  users = db.collection('users');
  txs = db.collection('transactions');
  loans = db.collection('loans');
  await users.createIndex({ email: 1 }, { unique: true });
  await users.createIndex({ phone: 1 }, { unique: true });
  await users.createIndex({ referral_code: 1 });
  console.log('MongoDB connected');
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
    referral_code: u.referral_code || null,
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

function generateReferralCode(name) {
  const base = (name || 'BB').replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase() || 'BB';
  return base + Math.floor(1000 + Math.random() * 9000);
}

function formatLoan(l) {
  return {
    id: l._id.toString(),
    amount: l.amount,
    months: l.months,
    rate: l.rate,
    monthly: l.monthly,
    total: l.total,
    interest: l.interest,
    paid: l.paid || 0,
    status: l.status || 'active',
    purpose: l.purpose || null,
    created_at: l.created_at,
    due_date: l.due_date || null,
  };
}

function buildSchedule(loan) {
  const schedule = [];
  const start = new Date(loan.created_at);
  for (let i = 1; i <= loan.months; i++) {
    const dueDate = new Date(start);
    dueDate.setMonth(dueDate.getMonth() + i);
    schedule.push({ month: i, due_date: dueDate, amount: loan.monthly, status: 'pending' });
  }
  return schedule;
}

// ============ AUTH ============

app.post('/api/register', async (req, res) => {
  try {
    const { name, email, phone, password, idNumber, referral } = req.body;
    if (!name || !email || !phone || !password)
      return res.status(400).json({ error: 'Missing fields' });

    const norm = normalizePhone(phone);
    const existing = await users.findOne({
      $or: [{ email: email.toLowerCase() }, { phone: norm }]
    });
    if (existing)
      return res.status(400).json({ error: 'Email or phone already registered' });

    const hash = await bcrypt.hash(password, 10);
    const userCode = generateReferralCode(name);
    const result = await users.insertOne({
      name,
      email: email.toLowerCase(),
      phone: norm,
      password_hash: hash,
      balance: 0,
      role: 'user',
      status: 'active',
      id_number: idNumber || null,
      referral_code: userCode,
      referred_by: null,
      created_at: new Date(),
    });

    notify(norm, 'Welcome!', `Welcome ${name.split(' ')[0]}! Your Biashara Boost wallet is ready. Log in to apply for a loan.`);

    if (referral && String(referral).trim()) {
      const refCode = String(referral).trim().toUpperCase();
      const referrer = await users.findOne({ referral_code: refCode });
      if (referrer && referrer._id.toString() !== result.insertedId.toString()) {
        await users.updateOne({ _id: referrer._id }, { $inc: { balance: REFERRAL_BONUS } });
        await users.updateOne({ _id: result.insertedId }, { $set: { referred_by: referrer._id.toString() } });
        await txs.insertOne({
          user_id: referrer._id.toString(),
          type: 'deposit',
          amount: REFERRAL_BONUS,
          description: `Referral bonus — ${name.split(' ')[0]} joined`,
          reference: makeRef(),
          status: 'completed',
          is_bonus: true,
          created_at: new Date(),
        });
        notify(referrer.phone, '💰 Referral Bonus!', `You earned KES ${REFERRAL_BONUS} referral bonus from ${name.split(' ')[0]}.`);
      }
    }

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
    if (!email || !password) return res.status(400).json({ error: 'Missing email or password' });

    const user = await users.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ error: 'No account found' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    const token = jwt.sign({ userId: user._id.toString() }, JWT_SECRET, { expiresIn: '90d' });
    res.json({ token, user: sanitize(user) });
  } catch (e) {
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

// ============ WALLET ============

app.get('/api/wallet/txs', auth, async (req, res) => {
  try {
    const list = await txs.find({ user_id: req.userId }).sort({ created_at: -1 }).limit(100).toArray();
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

    const me = await getUserById(req.userId);
    if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Only admins can deposit' });

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

    notify(user.phone, 'Withdrawal Confirmed', `You withdrew KES ${amt.toLocaleString()}. New balance KES ${(user.balance - amt).toLocaleString()}.`);

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

    const isLoan = sender.role === 'admin' && note && note.toUpperCase().startsWith('LOAN:');

    if (isLoan) {
      const months = parseInt(note.split(':')[1], 10) || 3;
      const rate = 10;
      const r = rate / 100 / 12;
      let monthly;
      if (r === 0) monthly = amt / months;
      else { const f = Math.pow(1 + r, months); monthly = amt * r * f / (f - 1); }
      monthly = Math.round(monthly);
      const total = monthly * months;
      const dueDate = new Date();
      dueDate.setMonth(dueDate.getMonth() + months);

      await loans.insertOne({
        user_id: recipient._id.toString(),
        amount: amt,
        months,
        rate,
        monthly,
        total,
        interest: total - amt,
        paid: 0,
        status: 'active',
        purpose: 'Loan disbursement',
        created_at: new Date(),
        due_date: dueDate,
      });

      notify(recipient.phone, '🎉 Loan Approved!', `Your loan of KES ${amt.toLocaleString()} is approved. Repay KES ${monthly.toLocaleString()}/month for ${months} months.`);
    } else {
      notify(recipient.phone, '💰 Money Received', `You received KES ${amt.toLocaleString()} from ${sender.name.split(' ')[0]}.`);
    }

    const updated = await getUserById(req.userId);
    res.json({ balance: updated.balance, recipient: { name: recipient.name, phone: recipient.phone } });
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
    res.json({ found: true, user: { name: user.name, phone: user.phone, status: user.status || 'active' } });
  } catch (e) {
    res.json({ found: false });
  }
});

// ============ LOANS ============

app.get('/api/loans', auth, async (req, res) => {
  try {
    const list = await loans.find({ user_id: req.userId }).sort({ created_at: -1 }).toArray();
    res.json({ loans: list.map(formatLoan) });
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/loans/:id', auth, async (req, res) => {
  try {
    const loan = await loans.findOne({ _id: new ObjectId(req.params.id), user_id: req.userId });
    if (!loan) return res.status(404).json({ error: 'Not found' });
    res.json({ loan: formatLoan(loan), schedule: buildSchedule(loan) });
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ============ PUBLIC LIVE PAYOUTS FEED ============
// Shows:
//   1. Real deposits (not bonuses, not admin)
//   2. Loan disbursements (transfer_in from admin "BIASHARA...")
app.get('/api/public/activity', async (req, res) => {
  try {
    const recent = await txs.find({
      $or: [
        { type: 'deposit', is_bonus: { $ne: true } },
        { type: 'transfer_in', description: { $regex: /^Received from BIASHARA/i } }
      ]
    }).sort({ created_at: -1 }).limit(40).toArray();

    const items = [];
    for (const t of recent) {
      if (items.length >= 10) break;
      const u = await users.findOne({ _id: new ObjectId(t.user_id) });
      if (u && u.role !== 'admin' && u.name !== 'BIASHARA LOANS LIMITED') {
        const parts = (u.name || 'User').split(' ').filter(Boolean);
        const masked = parts[0] + (parts[1] ? ' ' + parts[1][0] + '.' : '');
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