const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const AfricasTalking = require('africastalking');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// ===== Cloudinary Config =====
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';

// ============ DIAGNOSTIC ENDPOINTS ============
app.get('/api/test-loan', (req, res) => {
  res.json({ ok: true, message: 'Loan endpoint test successful', timestamp: new Date().toISOString() });
});

app.get('/api/diagnostic', (req, res) => {
  res.json({
    ok: true,
    deployed_at: new Date().toISOString(),
    has_loan_apply_route: true,
    has_admin_routes: true,
    has_notifications: true,
    has_fee_system: true,
    has_tiered_fees: true,
    has_clean_payouts: true,
    has_kyc: true,
    has_cloudinary: !!CLOUDINARY_CLOUD_NAME && !!CLOUDINARY_API_KEY,
    version: 'v9-cloudinary'
  });
});

const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'biashara-secret-change-me';

const REFERRAL_BONUS = 50;
const UNVERIFIED_LOAN_LIMIT = 5000;

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
    const result = await atSms.send({ to: [to], message });
    return result;
  } catch(e) {
    console.error('SMS failed:', e.message);
  }
}

async function sendPush(phone, title, message) {
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_KEY) return;
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
    return await res.json();
  } catch(e) {
    console.error('Push failed:', e.message);
  }
}

async function notify(phone, title, message, userId) {
  await Promise.allSettled([
    sendSMS(phone, message),
    sendPush(phone, title, message)
  ]);
  
  if (userId && notifications) {
    try {
      await notifications.insertOne({
        user_id: String(userId),
        title: title,
        message: message,
        read: false,
        created_at: new Date()
      });
    } catch(e) {
      console.error('Failed to save notification:', e.message);
    }
  }
}

// ===== Cloudinary Upload Helper (using REST API) =====
async function uploadToCloudinary(base64Data) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error('Cloudinary not configured');
  }
  
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'biashara-kyc';
  
  // Build signature (SHA1 of params + secret)
  const paramsToSign = `folder=${folder}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
  const signature = crypto.createHash('sha1').update(paramsToSign).digest('hex');
  
  // Prepare form data
  const formData = new URLSearchParams();
  formData.append('file', base64Data);
  formData.append('api_key', CLOUDINARY_API_KEY);
  formData.append('timestamp', timestamp);
  formData.append('folder', folder);
  formData.append('signature', signature);
  
  // Upload
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
  const res = await fetch(url, {
    method: 'POST',
    body: formData
  });
  
  const data = await res.json();
  
  if (!data.secure_url) {
    console.error('Cloudinary error:', data);
    throw new Error(data.error?.message || 'Cloudinary upload failed');
  }
  
  return data.secure_url;
}

let db, users, txs, loans, notifications, kyc;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('biashara');
  users = db.collection('users');
  txs = db.collection('transactions');
  loans = db.collection('loans');
  notifications = db.collection('notifications');
  kyc = db.collection('kyc');
  await users.createIndex({ email: 1 }, { unique: true });
  await users.createIndex({ phone: 1 }, { unique: true });
  await users.createIndex({ referral_code: 1 });
  await notifications.createIndex({ user_id: 1, created_at: -1 });
  await kyc.createIndex({ user_id: 1 });
  await kyc.createIndex({ status: 1, created_at: -1 });
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
    kyc_status: u.kyc_status || 'unverified',
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

function calculateFee(amount) {
  const amt = Number(amount) || 0;
  if (amt < 5000) return 400;
  if (amt <= 10000) return 400;
  if (amt <= 15000) return 600;
  if (amt <= 20000) return 800;
  if (amt <= 25000) return 1000;
  if (amt <= 50000) return 1500;
  if (amt <= 100000) return 2000;
  return 3000;
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
      kyc_status: 'unverified',
      created_at: new Date(),
    });

    const newUserId = result.insertedId.toString();
    notify(norm, 'Welcome!', `Welcome ${name.split(' ')[0]}! Your Biashara Loan wallet is ready.`, newUserId);

    if (referral && String(referral).trim()) {
      const refCode = String(referral).trim().toUpperCase();
      const referrer = await users.findOne({ referral_code: refCode });
      if (referrer && referrer._id.toString() !== newUserId) {
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
        notify(referrer.phone, '💰 Referral Bonus!', `You earned KES ${REFERRAL_BONUS} referral bonus.`, referrer._id.toString());
      }
    }

    const user = await getUserById(result.insertedId);
    const token = jwt.sign({ userId: newUserId }, JWT_SECRET, { expiresIn: '90d' });
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

// ============ KYC ============

app.post('/api/kyc/submit', auth, async (req, res) => {
  try {
    const { idPhoto, selfiePhoto, fullName, idNumber, dob } = req.body;
    if (!idPhoto || !selfiePhoto) {
      return res.status(400).json({ error: 'Both ID photo and selfie are required' });
    }
    if (!fullName || !idNumber) {
      return res.status(400).json({ error: 'Full name and ID number are required' });
    }

    const user = await getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.kyc_status === 'verified') {
      return res.status(400).json({ error: 'Your KYC is already verified' });
    }

    console.log('=== KYC SUBMIT ===');
    console.log('Uploading ID photo to Cloudinary...');
    const idUrl = await uploadToCloudinary(idPhoto);
    console.log('ID uploaded:', idUrl);

    console.log('Uploading selfie to Cloudinary...');
    const selfieUrl = await uploadToCloudinary(selfiePhoto);
    console.log('Selfie uploaded:', selfieUrl);

    const submission = {
      user_id: req.userId,
      full_name: fullName,
      id_number: idNumber,
      dob: dob || null,
      id_photo_url: idUrl,
      selfie_photo_url: selfieUrl,
      status: 'pending',
      submitted_at: new Date(),
      reviewed_at: null,
      reviewed_by: null,
      rejection_reason: null,
    };

    await kyc.deleteMany({ user_id: req.userId, status: 'pending' });
    const result = await kyc.insertOne(submission);

    await users.updateOne(
      { _id: new ObjectId(req.userId) },
      { $set: { kyc_status: 'pending', kyc_submitted_at: new Date() } }
    );

    notify(user.phone, '📋 KYC Received', `Your identity verification has been received. We'll review it within 24 hours.`, req.userId);

    res.json({
      ok: true,
      submissionId: result.insertedId.toString(),
      status: 'pending',
      message: 'KYC submitted successfully. We will review within 24 hours.'
    });
  } catch (e) {
    console.error('KYC submit error:', e);
    res.status(500).json({ error: 'KYC submission failed: ' + e.message });
  }
});

app.get('/api/kyc/status', auth, async (req, res) => {
  try {
    const user = await getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const submission = await kyc.findOne(
      { user_id: req.userId },
      { sort: { submitted_at: -1 } }
    );

    res.json({
      kyc_status: user.kyc_status || 'unverified',
      submission: submission ? {
        id: submission._id.toString(),
        status: submission.status,
        full_name: submission.full_name,
        id_number: submission.id_number,
        submitted_at: submission.submitted_at,
        reviewed_at: submission.reviewed_at,
        rejection_reason: submission.rejection_reason || null,
      } : null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/admin/pending-kyc', auth, async (req, res) => {
  try {
    const admin = await getUserById(req.userId);
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admins only' });

    const pending = await kyc.aggregate([
      { $match: { status: 'pending' } },
      { $sort: { submitted_at: -1 } },
      {
        $lookup: {
          from: 'users',
          let: { uid: '$user_id' },
          pipeline: [
            { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$uid'] } } },
            { $project: { name: 1, phone: 1, email: 1, kyc_status: 1 } }
          ],
          as: 'user'
        }
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $limit: 100 }
    ]).toArray();

    const items = pending.map(k => ({
      id: k._id.toString(),
      user_id: k.user_id,
      full_name: k.full_name,
      id_number: k.id_number,
      dob: k.dob,
      id_photo_url: k.id_photo_url,
      selfie_photo_url: k.selfie_photo_url,
      submitted_at: k.submitted_at,
      user: k.user ? {
        name: k.user.name,
        phone: k.user.phone,
        email: k.user.email,
      } : { name: 'Unknown', phone: 'Unknown', email: 'Unknown' }
    }));

    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load pending KYC' });
  }
});

app.post('/api/admin/approve-kyc', auth, async (req, res) => {
  try {
    const admin = await getUserById(req.userId);
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admins only' });

    const { kycId, action, reason } = req.body;
    if (!kycId || !action) return res.status(400).json({ error: 'Missing kycId or action' });
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const submission = await kyc.findOne({ _id: new ObjectId(kycId) });
    if (!submission) return res.status(404).json({ error: 'KYC not found' });
    if (submission.status !== 'pending') return res.status(400).json({ error: 'Already reviewed' });

    const newStatus = action === 'approve' ? 'verified' : 'rejected';

    await kyc.updateOne(
      { _id: new ObjectId(kycId) },
      {
        $set: {
          status: newStatus,
          reviewed_at: new Date(),
          reviewed_by: admin._id.toString(),
          rejection_reason: action === 'reject' ? (reason || 'Documents not clear') : null,
        }
      }
    );

    await users.updateOne(
      { _id: new ObjectId(submission.user_id) },
      { $set: { kyc_status: newStatus, kyc_verified_at: action === 'approve' ? new Date() : null } }
    );

    const user = await users.findOne({ _id: new ObjectId(submission.user_id) });
    if (user) {
      if (action === 'approve') {
        notify(user.phone, '✅ KYC Approved!', `Your identity has been verified. You can now apply for loans up to KES 500,000.`, submission.user_id);
      } else {
        notify(user.phone, '❌ KYC Rejected', `Your KYC was rejected. Reason: ${reason || 'Documents not clear'}. Please resubmit.`, submission.user_id);
      }
    }

    res.json({ ok: true, status: newStatus });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'KYC review failed' });
  }
});

// ============ NOTIFICATIONS ============

app.get('/api/notifications', auth, async (req, res) => {
  try {
    const list = await notifications
      .find({ user_id: req.userId })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();
    
    const items = list.map(n => ({
      id: n._id.toString(),
      title: n.title,
      message: n.message,
      read: n.read || false,
      created_at: n.created_at
    }));
    
    const unreadCount = items.filter(n => !n.read).length;
    res.json({ items, unreadCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

app.post('/api/notifications/read', auth, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing ID' });
    await notifications.updateOne(
      { _id: new ObjectId(id), user_id: req.userId },
      { $set: { read: true } }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

app.post('/api/notifications/read-all', auth, async (req, res) => {
  try {
    await notifications.updateMany(
      { user_id: req.userId, read: false },
      { $set: { read: true } }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

app.delete('/api/notifications/:id', auth, async (req, res) => {
  try {
    await notifications.deleteOne({ 
      _id: new ObjectId(req.params.id), 
      user_id: req.userId 
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});// ============ WALLET ============

app.get('/api/wallet/txs', auth, async (req, res) => {
  try {
    const list = await txs.find({ user_id: req.userId }).sort({ created_at: -1 }).limit(100).toArray();
    const formatted = list.map(t => ({
      id: t._id.toString(),
      type: t.type,
      amount: t.amount,
      fee: t.fee || null,
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

    const fee = calculateFee(amt);

    await users.updateOne({ _id: new ObjectId(req.userId) }, { $inc: { balance: -amt } });

    const ref = makeRef();
    await txs.insertOne({
      user_id: req.userId,
      type: 'withdrawal',
      amount: amt,
      fee: fee,
      description: 'Withdrawal to M-Pesa',
      reference: ref,
      status: 'pending',
      mpesa_receipt: null,
      created_at: new Date(),
    });

    notify(user.phone, '⏳ Withdrawal Pending', `Your withdrawal request for KES ${amt.toLocaleString()} is pending. Security fee to pay: KES ${fee.toLocaleString()}.`, req.userId);

    const updated = await getUserById(req.userId);
    res.json({ 
      balance: updated.balance, 
      reference: ref, 
      fee: fee,
      amount: amt,
      feePayable: fee,
      message: `Withdrawal of KES ${amt.toLocaleString()} is pending. Pay security fee of KES ${fee.toLocaleString()} to release.`
    });
  } catch (e) {
    console.error(e);
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

      notify(recipient.phone, '🎉 Loan Approved!', `Your loan of KES ${amt.toLocaleString()} is approved.`, recipient._id.toString());
    } else {
      notify(recipient.phone, '💰 Money Received', `You received KES ${amt.toLocaleString()} from ${sender.name.split(' ')[0]}.`, recipient._id.toString());
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

app.post('/api/loans/apply', auth, async (req, res) => {
  try {
    console.log('=== LOAN APPLY HIT ===');
    console.log('Body received:', JSON.stringify(req.body));
    
    const { fullName, phone, email, amount, months, purpose, employment, idNumber } = req.body;
    const user = await getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const amt = Number(String(amount || '').replace(/[^\d.]/g, ''));
    const mnths = Number(String(months || '').replace(/[^\d]/g, ''));
    
    console.log('Parsed amount:', amt, 'months:', mnths);
    
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount: received "' + amount + '"' });
    if (!mnths || mnths <= 0) return res.status(400).json({ error: 'Invalid months: received "' + months + '"' });

    // KYC CHECK
    const kycStatus = user.kyc_status || 'unverified';
    if (amt > UNVERIFIED_LOAN_LIMIT && kycStatus !== 'verified') {
      return res.status(403).json({
        error: `Identity verification required. Unverified users can borrow up to KES ${UNVERIFIED_LOAN_LIMIT.toLocaleString()}. Please complete KYC to access larger loans.`,
        kyc_required: true,
        kyc_status: kycStatus,
        max_unverified: UNVERIFIED_LOAN_LIMIT
      });
    }

    const rate = 10;
    const r = rate / 100 / 12;
    let monthly;
    if (r === 0) monthly = amt / mnths;
    else { const f = Math.pow(1 + r, mnths); monthly = amt * r * f / (f - 1); }
    monthly = Math.round(monthly);
    const total = monthly * mnths;

    const dueDate = new Date();
    dueDate.setMonth(dueDate.getMonth() + mnths);

    const result = await loans.insertOne({
      user_id: req.userId,
      amount: amt,
      months: mnths,
      rate,
      monthly,
      total,
      interest: total - amt,
      paid: 0,
      status: 'pending',
      purpose: purpose || 'Business Loan',
      employment: employment || 'N/A',
      id_number: idNumber || user.id_number || 'N/A',
      full_name: fullName || user.name,
      phone: phone || user.phone,
      email: email || user.email,
      kyc_status_at_apply: kycStatus,
      created_at: new Date(),
      due_date: dueDate,
    });

    console.log('Loan inserted:', result.insertedId.toString());

    notify(user.phone, '📝 Application Received', `Hi ${user.name.split(' ')[0]}, we received your loan application for KES ${amt.toLocaleString()}. We'll review within 24 hours.`, req.userId).catch(e => console.error('Notify failed:', e.message));

    res.json({ ok: true, loanId: result.insertedId.toString() });
  } catch (e) {
    console.error('LOAN APPLY ERROR:', e);
    res.status(500).json({ error: 'Loan failed: ' + e.message });
  }
});

// ============ ADMIN: LIST PENDING WITHDRAWALS ============
app.get('/api/admin/pending-withdrawals', auth, async (req, res) => {
  try {
    const admin = await getUserById(req.userId);
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admins only' });

    const pending = await txs.aggregate([
      { $match: { type: 'withdrawal', status: 'pending' } },
      { $sort: { created_at: -1 } },
      {
        $lookup: {
          from: 'users',
          let: { uid: '$user_id' },
          pipeline: [
            { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$uid'] } } },
            { $project: { name: 1, phone: 1, email: 1, balance: 1, kyc_status: 1 } }
          ],
          as: 'user'
        }
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $limit: 100 }
    ]).toArray();

    const items = pending.map(t => ({
      id: t._id.toString(),
      amount: t.amount,
      fee: t.fee || calculateFee(t.amount),
      reference: t.reference,
      created_at: t.created_at,
      description: t.description,
      user: t.user ? {
        name: t.user.name,
        phone: t.user.phone,
        email: t.user.email,
        balance: t.user.balance,
        kyc_status: t.user.kyc_status || 'unverified'
      } : { name: 'Unknown', phone: 'Unknown', email: 'Unknown', balance: 0, kyc_status: 'unverified' }
    }));

    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load pending withdrawals' });
  }
});

// ============ ADMIN: APPROVE WITHDRAWAL ============
app.post('/api/admin/approve-withdrawal', auth, async (req, res) => {
  try {
    const admin = await getUserById(req.userId);
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admins only' });

    const { txId, mpesaReceipt } = req.body;
    if (!txId) return res.status(400).json({ error: 'Missing transaction ID' });

    const tx = await txs.findOne({ _id: new ObjectId(txId), type: 'withdrawal' });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status === 'completed') return res.status(400).json({ error: 'Already completed' });

    const finalReceipt = mpesaReceipt || ('QK' + Date.now().toString().slice(-8));

    await txs.updateOne(
      { _id: new ObjectId(txId) },
      { $set: { status: 'completed', mpesa_receipt: finalReceipt, description: 'Withdrawal to M-Pesa' } }
    );

    const user = await users.findOne({ _id: new ObjectId(tx.user_id) });
    if (user) {
      notify(user.phone, '✅ Withdrawal Complete', `Your withdrawal of KES ${tx.amount.toLocaleString()} has been sent. Receipt: ${finalReceipt}`, tx.user_id);
    }

    res.json({ ok: true, receipt: finalReceipt });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Approval failed' });
  }
});

// ============ ADMIN: LIST PENDING LOANS ============
app.get('/api/admin/pending-loans', auth, async (req, res) => {
  try {
    const admin = await getUserById(req.userId);
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admins only' });

    const pending = await loans.find({ status: 'pending' }).sort({ created_at: -1 }).limit(100).toArray();

    const items = pending.map(l => ({
      id: l._id.toString(),
      full_name: l.full_name || 'N/A',
      phone: l.phone || 'N/A',
      email: l.email || 'N/A',
      amount: l.amount,
      months: l.months,
      monthly: l.monthly,
      total: l.total,
      purpose: l.purpose || 'N/A',
      employment: l.employment || 'N/A',
      id_number: l.id_number || 'N/A',
      kyc_status: l.kyc_status_at_apply || 'unverified',
      created_at: l.created_at,
      user_id: l.user_id
    }));

    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load pending loans' });
  }
});

// ============ ADMIN: APPROVE LOAN ============
app.post('/api/admin/approve-loan', auth, async (req, res) => {
  try {
    const admin = await getUserById(req.userId);
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admins only' });

    const { loanId } = req.body;
    if (!loanId) return res.status(400).json({ error: 'Missing loan ID' });

    const loan = await loans.findOne({ _id: new ObjectId(loanId) });
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    if (loan.status === 'active') return res.status(400).json({ error: 'Already approved' });

    await loans.updateOne(
      { _id: new ObjectId(loanId) },
      { $set: { status: 'active', approved_at: new Date() } }
    );

    const user = await users.findOne({ _id: new ObjectId(loan.user_id) });
    if (user) {
      notify(user.phone, '🎉 Loan Approved!', `Your loan of KES ${loan.amount.toLocaleString()} has been approved. Repay KES ${loan.monthly.toLocaleString()}/month for ${loan.months} months.`, loan.user_id);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Loan approval failed' });
  }
});

// ============ PUBLIC LIVE PAYOUTS FEED ============
app.get('/api/public/activity', async (req, res) => {
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const recent = await txs.aggregate([
      {
        $match: {
          created_at: { $gte: twoHoursAgo },
          status: 'completed',
          $or: [
            { type: 'withdrawal', mpesa_receipt: { $exists: true, $ne: null } },
            { type: 'deposit', is_bonus: { $ne: true } }
          ]
        }
      },
      { $sort: { created_at: -1 } },
      { $limit: 20 },
      {
        $lookup: {
          from: 'users',
          let: { uid: '$user_id' },
          pipeline: [
            { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$uid'] } } },
            { $project: { name: 1, role: 1 } }
          ],
          as: 'user'
        }
      },
      { $unwind: '$user' },
      { $match: { 'user.role': { $ne: 'admin' }, 'user.name': { $ne: 'BIASHARA LOANS LIMITED' } } },
      { $limit: 10 }
    ]).toArray();

    const items = recent.map(t => {
      const parts = (t.user.name || 'User').split(' ').filter(Boolean);
      const masked = parts[0] + (parts[1] ? ' ' + parts[1][0] + '.' : '');
      return { name: masked, amount: t.amount, at: t.created_at, type: t.type };
    });

    res.json({ items });
  } catch (e) {
    console.error(e);
    res.json({ items: [] });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Biashara backend is running', version: 'v9-cloudinary' }));

connectDB().then(() => {
  app.listen(PORT, () => console.log('Server running on port ' + PORT));
}).catch(err => {
  console.error('DB connection failed:', err);
  process.exit(1);
});