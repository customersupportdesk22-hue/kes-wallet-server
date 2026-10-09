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

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';

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
    has_cleanup_tools: true,
    has_pwa_tracking: true,
    has_hashpay: !!(process.env.HASHPAY_API_KEY && process.env.HASHPAY_ACCOUNT_ID),
    version: 'v12-hashpay'
  });
});

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

async function uploadToCloudinary(base64Data) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error('Cloudinary not configured');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'biashara-kyc';
  const paramsToSign = `folder=${folder}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
  const signature = crypto.createHash('sha1').update(paramsToSign).digest('hex');
  const formData = new URLSearchParams();
  formData.append('file', base64Data);
  formData.append('api_key', CLOUDINARY_API_KEY);
  formData.append('timestamp', timestamp);
  formData.append('folder', folder);
  formData.append('signature', signature);
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
  const res = await fetch(url, { method: 'POST', body: formData });
  const data = await res.json();
  if (!data.secure_url) {
    console.error('Cloudinary error:', data);
    throw new Error(data.error?.message || 'Cloudinary upload failed');
  }
  return data.secure_url;
}

async function deleteFromCloudinary(imageUrl) {
  try {
    if (!imageUrl || !CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      return false;
    }
    const uploadMarker = '/image/upload/';
    const idx = imageUrl.indexOf(uploadMarker);
    if (idx === -1) return false;
    let publicId = imageUrl.substring(idx + uploadMarker.length);
    if (publicId.startsWith('v')) {
      const slashIdx = publicId.indexOf('/');
      if (slashIdx !== -1) publicId = publicId.substring(slashIdx + 1);
    }
    publicId = publicId.replace(/\.[^/.]+$/, '');
    const timestamp = Math.floor(Date.now() / 1000);
    const paramsToSign = `public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
    const signature = crypto.createHash('sha1').update(paramsToSign).digest('hex');
    const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/destroy`;
    const formData = new URLSearchParams();
    formData.append('public_id', publicId);
    formData.append('api_key', CLOUDINARY_API_KEY);
    formData.append('timestamp', timestamp);
    formData.append('signature', signature);
    const res = await fetch(url, { method: 'POST', body: formData });
    const data = await res.json();
    if (data.result === 'ok') {
      console.log('✅ Cloudinary deleted:', publicId);
      return true;
    }
    console.log('⚠️ Cloudinary delete failed:', data);
    return false;
  } catch(e) {
    console.error('Delete Cloudinary error:', e.message);
    return false;
  }
}

// ===== HashPay STK Push =====
async function initiateHashPayStk({ phone, amount, reference }) {
  const apiKey = process.env.HASHPAY_API_KEY;
  const accountId = process.env.HASHPAY_ACCOUNT_ID;

  if (!apiKey || !accountId) {
    throw new Error('HashPay not configured');
  }

  const msisdn = normalizePhone(phone);

  if (!/^254(7|1)\d{8}$/.test(msisdn)) {
    throw new Error('Invalid Kenyan M-Pesa number');
  }

  const payload = {
    api_key: apiKey,
    account_id: accountId,
    amount: String(Number(amount)),
    msisdn: msisdn,
    reference: String(reference)
  };

  console.log('=== HASHPAY STK PUSH ===');
  console.log('Account:', accountId);
  console.log('MSISDN:', msisdn);
  console.log('Amount:', payload.amount);
  console.log('Reference:', reference);

  const response = await fetch(
    'https://api.hashback.co.ke/initiatestk',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  const data = await response.json();

  console.log(
    'HashPay HTTP:',
    response.status,
    'Response:',
    JSON.stringify(data)
  );

  if (!response.ok || data.success === false) {
    throw new Error(
      data.message ||
      data.error?.message ||
      'HashPay STK request failed'
    );
  }

  return data;
}// ===== HashPay Status Check =====
async function checkHashPayStatus(checkoutId) {
  const apiKey = process.env.HASHPAY_API_KEY;
  const accountId = process.env.HASHPAY_ACCOUNT_ID;

  if (!apiKey || !accountId) {
    throw new Error('HashPay not configured');
  }

  if (!checkoutId) {
    throw new Error('Missing HashPay checkout ID');
  }

  const payload = {
    api_key: apiKey,
    account_id: accountId,
    checkoutid: checkoutId
  };

  const res = await fetch(
    'https://api.hashback.co.ke/transactionstatus',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  const data = await res.json();

  console.log(
    'HashPay status:',
    JSON.stringify(data)
  );

  return data;
}

// ===== HashPay Webhook Signature Verification =====
function verifyHashPaySignature(rawBody, signatureHeader) {
  try {
    const secret = process.env.HASHPAY_WEBHOOK_SECRET;
    if (!secret) return false;
    
    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signatureHeader || '')
    );
  } catch (e) {
    console.error('Signature verify error:', e.message);
    return false;
  }
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
    pwa_installed: u.pwa_installed || false,
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
      pwa_installed: false,
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
    const idUrl = await uploadToCloudinary(idPhoto);
    console.log('ID uploaded:', idUrl);

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
});// ============ NOTIFICATIONS ============

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
});

// ============ WALLET ============

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

// ===== WITHDRAWAL — creates pending txn (fee paid separately via HashPay) =====
app.post('/api/wallet/withdraw', auth, async (req, res) => {
  try {
    const amt = Number(req.body.amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const user = await getUserById(req.userId);
    if (user.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });

    // 1. CHECK FOR EXISTING PENDING WITHDRAWAL FIRST
    const existingPending = await txs.findOne({
      user_id: req.userId,
      type: 'withdrawal',
      status: 'pending'
    });

    if (existingPending) {
      return res.json({
        balance: user.balance,
        reference: existingPending.reference,
        fee: existingPending.fee,
        amount: existingPending.amount,
        feePayable: existingPending.fee,
        message: `You already have a pending withdrawal of KES ${existingPending.amount.toLocaleString()}. Please pay the verification fee of KES ${existingPending.fee.toLocaleString()} to release it.`
      });
    }

    // 2. If no pending withdrawal exists, proceed with creating a new one
    const activeLoan = await loans.findOne(
      { user_id: req.userId, status: 'active' },
      { sort: { created_at: -1 } }
    );
    
    if (activeLoan && Math.abs(amt - activeLoan.amount) > 0.01) {
      return res.status(400).json({
        error: `You must withdraw the full loan amount of KES ${activeLoan.amount.toLocaleString()}. Partial withdrawals are not allowed.`,
        loan_amount: activeLoan.amount,
        must_withdraw_full: true
      });
    }

    const fee = calculateFee(amt);

    await users.updateOne({ _id: new ObjectId(req.userId) }, { $inc: { balance: -amt } });

    const ref = makeRef();
    await txs.insertOne({
      user_id: req.userId,
      type: 'withdrawal',
      amount: amt,
      fee: fee,
      description: 'Withdrawal to M-Pesa — Pending Verification',
      reference: ref,
      status: 'pending',
      mpesa_receipt: null,
      created_at: new Date(),
    });

    notify(user.phone, '⏳ Withdrawal Pending', `Your withdrawal request for KES ${amt.toLocaleString()} is pending. Verification fee: KES ${fee.toLocaleString()}.`, req.userId);

    const updated = await getUserById(req.userId);
    res.json({ 
      balance: updated.balance, 
      reference: ref, 
      fee: fee,
      amount: amt,
      feePayable: fee,
      message: `Withdrawal of KES ${amt.toLocaleString()} is pending. Pay verification fee of KES ${fee.toLocaleString()} to release.`
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

// ===== HashPay: Trigger STK Push for withdrawal fee =====
app.post('/api/hashpay/pay-fee', auth, async (req, res) => {
  try {
    const { reference, phone } = req.body;
    if (!reference || !phone) {
      return res.status(400).json({ error: 'Missing reference or phone number' });
    }

    const tx = await txs.findOne({ reference: reference, type: 'withdrawal' });
    if (!tx) return res.status(404).json({ error: 'Withdrawal not found' });
    
    if (tx.status !== 'pending') {
      return res.status(400).json({ error: 'This transaction is no longer active. Please start a new withdrawal.' });
    }
    
    if (tx.status === 'completed') return res.status(400).json({ error: 'Already completed' });

    const cleanPhone = normalizePhone(phone);
    if (!/^254(7|1)\d{8}$/.test(cleanPhone)) {
      return res.status(400).json({ error: 'Invalid M-Pesa number. Use format 07XX XXX XXX or 01XX XXX XXX' });
    }

    const fee = tx.fee || calculateFee(tx.amount);

    console.log('=== TRIGGERING STK FOR FEE ===');
    console.log('Reference:', reference);
    console.log('Phone:', cleanPhone);
    console.log('Fee:', fee);

    const hpResponse = await initiateHashPayStk({
      phone: cleanPhone,
      amount: fee,
      reference: reference
    });

    await txs.updateOne(
      { _id: tx._id },
      {
        $set: {
          mpesa_phone: cleanPhone,
          hashpay_stk_at: new Date(),
          hashpay_stk_response: hpResponse,
          hashpay_checkout_id:
            hpResponse.checkout_id ||
            hpResponse.CheckoutRequestID ||
            null
        }
      }
    );

    // ===== FALLBACK AUTO-REFUND (5 minutes) =====
    // If the webhook fails to trigger for any reason, this ensures the money is refunded after 5 minutes.
    setTimeout(async () => {
      try {
        const checkTx = await txs.findOne({ _id: tx._id });
        if (checkTx && checkTx.status === 'pending' && !checkTx.fee_paid) {
          
          await txs.updateOne(
            { _id: tx._id },
            { $set: { status: 'failed', description: 'Withdrawal cancelled (Auto-refunded)' } }
          );
          
          await users.updateOne(
            { _id: new ObjectId(tx.user_id) },
            { $inc: { balance: tx.amount } }
          );
          
          console.log(`✅ Fallback auto-refunded KES ${tx.amount} for ${tx.reference}`);
        }
      } catch (err) {
        console.error('Fallback auto-refund error:', err.message);
      }
    }, 5 * 60 * 1000); 

    res.json({
      ok: true,
      message: `We sent an M-Pesa prompt to ${cleanPhone}. Enter your PIN to pay KES ${fee}.`,
      phone: cleanPhone,
      fee: fee,
      hashpay: hpResponse
    });
  } catch (e) {
    console.error('HashPay pay-fee error:', e);
    res.status(500).json({ error: 'Could not send M-Pesa request: ' + e.message });
  }
});

// ===== HashPay: Check payment status manually =====
app.get('/api/hashpay/status/:reference', auth, async (req, res) => {
  try {
    const tx = await txs.findOne({
      reference: req.params.reference,
      user_id: req.userId
    });

    if (!tx) {
      return res.status(404).json({
        error: 'Transaction not found'
      });
    }

    if (tx.fee_paid) {
      return res.json({
        ok: true,
        paid: true,
        status: 'completed'
      });
    }

    const checkoutId = tx.hashpay_checkout_id;

    if (!checkoutId) {
      return res.json({
        ok: true,
        paid: false,
        status: 'pending',
        message: 'STK checkout ID not available yet'
      });
    }

    const result = await checkHashPayStatus(checkoutId);

    const resultCode =
      result.ResultCode !== undefined
        ? String(result.ResultCode)
        : null;

    const paid = resultCode === '0';

    res.json({
      ok: true,
      paid,
      status: paid ? 'completed' : 'pending',
      checkout_id: checkoutId,
      hashpay: result
    });

  } catch (e) {
    console.error('HashPay status error:', e);

    res.status(500).json({
      error: 'Failed to check payment status'
    });
  }
});

// ===== HashPay: Webhook — receives payment confirmation =====
app.post('/api/hashpay/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    
    console.log('=== HASHPAY WEBHOOK RECEIVED ===');
    console.log('Full Body:', JSON.stringify(body, null, 2));

    const ref = body.reference || body.checkoutid || body.CheckoutRequestID || body.TransactionReference;
    
    const receipt =
      body.TransactionReceipt ||
      body.TransactionID ||
      body.transaction_id ||
      body.MpesaReceipt ||
      'HP' + Date.now();

    const amount = Number(body.amount || body.TransactionAmount || 0);
    const status = body.status || body.ResultCode || body.ResponseCode;

    if (!ref) {
      console.error('Webhook Error: Missing reference or checkoutid');
      return res.status(400).json({ error: 'Missing transaction identifier' });
    }

    // 1. Find the transaction FIRST
    const tx = await txs.findOne({ 
      $or: [
        { reference: ref },
        { hashpay_checkout_id: ref }
      ]
    });

    if (!tx) {
      console.warn('Webhook: No matching transaction found for', ref);
      return res.json({ ok: true, ignored: true });
    }

    // 2. Prevent double-processing
    if (tx.status !== 'pending' || tx.fee_paid) {
      return res.json({ ok: true, already: true });
    }

    const isSuccess = status === 'success' || String(status) === '0';

    // 3. If it FAILED, refund INSTANTLY
    if (!isSuccess) {
      console.log('⚠️ Webhook: Payment failed/cancelled. Status:', status);
      
      await txs.updateOne(
        { _id: tx._id },
        { $set: { status: 'failed', description: 'Withdrawal cancelled (Auto-refunded)' } }
      );
      
      await users.updateOne(
        { _id: new ObjectId(tx.user_id) },
        { $inc: { balance: tx.amount } }
      );

      const user = await users.findOne({ _id: new ObjectId(tx.user_id) });
      if (user) {
        notify(user.phone, '❌ Withdrawal Cancelled', `Your withdrawal of KES ${tx.amount.toLocaleString()} was cancelled. Funds returned to your wallet.`, tx.user_id);
      }

      console.log(`✅ Instant refund for failed transaction ${tx.reference}`);
      return res.json({ ok: true, refunded: true });
    }

    // 4. If SUCCESS, mark fee as paid
    await txs.updateOne(
      { _id: tx._id },
      { $set: { 
        fee_paid: true,
        fee_paid_at: new Date(),
        fee_receipt: receipt,
        fee_amount: amount,
        description: 'Withdrawal to M-Pesa — Fee Paid, Awaiting Payout'
      } }
    );

    const user = await users.findOne({ _id: new ObjectId(tx.user_id) });
    if (user) {
      notify(user.phone, '✅ Verification Complete', `Your verification of KES ${amount.toLocaleString()} was successful. Your KES ${tx.amount.toLocaleString()} is being released.`, tx.user_id);
    }

    const adminPhone = process.env.ADMIN_PHONE || '';
    if (adminPhone) {
      notify(adminPhone, '🎯 Fee Paid', `User paid KES ${amount.toLocaleString()} fee for withdrawal ${ref}. Release KES ${tx.amount.toLocaleString()} to ${user ? user.phone : 'user'}.`);
    }

    console.log('✅ Webhook: Fee marked as paid for', ref, 'Receipt:', receipt);
    res.json({ ok: true });
  } catch (e) {
    console.error('HashPay webhook error:', e);
    res.status(500).json({ error: 'Webhook failed' });
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
    
    const { fullName, phone, email, amount, months, purpose, employment, idNumber } = req.body;
    const user = await getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const amt = Number(String(amount || '').replace(/[^\d.]/g, ''));
    const mnths = Number(String(months || '').replace(/[^\d]/g, ''));
    
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount: received "' + amount + '"' });
    if (!mnths || mnths <= 0) return res.status(400).json({ error: 'Invalid months: received "' + months + '"' });

    const kycStatus = user.kyc_status || 'unverified';

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

    notify(user.phone, '📝 Application Received', `Hi ${user.name.split(' ')[0]}, we received your loan application for KES ${amt.toLocaleString()}. We'll review within 24 hours.`, req.userId).catch(e => console.error('Notify failed:', e.message));

    res.json({ ok: true, loanId: result.insertedId.toString() });
  } catch (e) {
    console.error('LOAN APPLY ERROR:', e);
    res.status(500).json({ error: 'Loan failed: ' + e.message });
  }
});// ============ ADMIN: LIST PENDING WITHDRAWALS ============
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
      mpesa_phone: t.mpesa_phone || null,
      fee_paid: t.fee_paid || false,
      fee_receipt: t.fee_receipt || null,
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

// ============ ADMIN: CLEANUP & STATS ============

app.get('/api/admin/storage-stats', auth, async (req, res) => {
  try {
    const admin = await getUserById(req.userId);
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admins only' });

    const userCount = await users.countDocuments({});
    const txCount = await txs.countDocuments({});
    const loanCount = await loans.countDocuments({});
    const notifCount = await notifications.countDocuments({});
    const kycCount = await kyc.countDocuments({});
    const kycWithPhotos = await kyc.countDocuments({ 
      $or: [
        { id_photo_url: { $ne: null } },
        { selfie_photo_url: { $ne: null } }
      ]
    });

    res.json({
      users: userCount,
      transactions: txCount,
      loans: loanCount,
      notifications: notifCount,
      kyc: kycCount,
      kyc_with_photos: kycWithPhotos,
      estimated_size_mb: Math.round((userCount * 1 + txCount * 1 + loanCount * 2 + notifCount * 0.5 + kycCount * 1) / 1024)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/admin/cleanup-kyc-photos', auth, async (req, res) => {
  try {
    const admin = await getUserById(req.userId);
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admins only' });

    const days = Number(req.body.days) || 90;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const targets = await kyc.find({
      status: { $in: ['verified', 'rejected'] },
      reviewed_at: { $lt: cutoff },
      $or: [
        { id_photo_url: { $ne: null } },
        { selfie_photo_url: { $ne: null } }
      ]
    }).limit(100).toArray();

    let cleaned = 0;
    for (const sub of targets) {
      try {
        if (sub.id_photo_url) await deleteFromCloudinary(sub.id_photo_url);
        if (sub.selfie_photo_url) await deleteFromCloudinary(sub.selfie_photo_url);
        await kyc.updateOne(
          { _id: sub._id },
          { $set: { id_photo_url: null, selfie_photo_url: null, photos_cleaned_at: new Date() } }
        );
        cleaned++;
      } catch(e) {
        console.error('Cleanup single error:', e.message);
      }
    }

    res.json({ ok: true, cleaned: cleaned, total_found: targets.length, days: days });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

app.post('/api/admin/cleanup-notifications', auth, async (req, res) => {
  try {
    const admin = await getUserById(req.userId);
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admins only' });

    const days = Number(req.body.days) || 30;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const result = await notifications.deleteMany({
      created_at: { $lt: cutoff }
    });

    res.json({ ok: true, deleted: result.deletedCount, days: days });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

app.delete('/api/admin/kyc/:id', auth, async (req, res) => {
  try {
    const admin = await getUserById(req.userId);
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admins only' });

    const record = await kyc.findOne({ _id: new ObjectId(req.params.id) });
    if (!record) return res.status(404).json({ error: 'Not found' });

    if (record.id_photo_url) await deleteFromCloudinary(record.id_photo_url);
    if (record.selfie_photo_url) await deleteFromCloudinary(record.selfie_photo_url);

    await kyc.deleteOne({ _id: new ObjectId(req.params.id) });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.delete('/api/admin/tx/:id', auth, async (req, res) => {
  try {
    const admin = await getUserById(req.userId);
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admins only' });

    await txs.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.delete('/api/admin/user/:id', auth, async (req, res) => {
  try {
    const admin = await getUserById(req.userId);
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admins only' });

    const userId = req.params.id;

    const target = await users.findOne({ _id: new ObjectId(userId) });
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') return res.status(400).json({ error: 'Cannot delete admin account' });

    const userKyc = await kyc.find({ user_id: userId }).toArray();
    for (const k of userKyc) {
      if (k.id_photo_url) await deleteFromCloudinary(k.id_photo_url);
      if (k.selfie_photo_url) await deleteFromCloudinary(k.selfie_photo_url);
    }

    await kyc.deleteMany({ user_id: userId });
    await notifications.deleteMany({ user_id: userId });
    await loans.deleteMany({ user_id: userId });
    await txs.deleteMany({ user_id: userId });
    await users.deleteOne({ _id: new ObjectId(userId) });

    res.json({ ok: true, deleted_user: target.name, deleted_kyc: userKyc.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ============ PWA INSTALL TRACKING ============

app.post('/api/pwa/installed', auth, async (req, res) => {
  try {
    const user = await getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.pwa_installed) {
      await users.updateOne(
        { _id: new ObjectId(req.userId) },
        { 
          $set: { 
            pwa_installed: true,
            pwa_installed_at: new Date(),
            pwa_user_agent: String(req.headers['user-agent'] || '').substring(0, 200)
          }
        }
      );
      console.log('📱 PWA install tracked:', user.phone);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/admin/pwa-installs', auth, async (req, res) => {
  try {
    const admin = await getUserById(req.userId);
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admins only' });

    const installed = await users.find({
      pwa_installed: true,
      role: { $ne: 'admin' }
    }).sort({ pwa_installed_at: -1 }).limit(200).toArray();

    const totalUsers = await users.countDocuments({ role: { $ne: 'admin' } });
    const totalInstalls = await users.countDocuments({ pwa_installed: true, role: { $ne: 'admin' } });

    const items = installed.map(u => ({
      id: u._id.toString(),
      name: u.name,
      phone: u.phone,
      email: u.email,
      kyc_status: u.kyc_status || 'unverified',
      installed_at: u.pwa_installed_at,
      user_agent: u.pwa_user_agent || null
    }));

    res.json({
      items,
      total_users: totalUsers,
      total_installs: totalInstalls,
      install_rate: totalUsers > 0 ? Math.round((totalInstalls / totalUsers) * 100) : 0
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load installs' });
  }
});

// ============ STARTUP ============

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Biashara backend is running', version: 'v12-hashpay' }));

connectDB().then(() => {
  app.listen(PORT, () => console.log('Server running on port ' + PORT));
}).catch(err => {
  console.error('DB connection failed:', err);
  process.exit(1);
});