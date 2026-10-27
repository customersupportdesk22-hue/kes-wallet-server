const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendEmail(to, subject, htmlContent) {
  if (!process.env.RESEND_API_KEY) return false;
  try {
    const { data, error } = await resend.emails.send({
      from: 'KCB Biashara Loans <info@biasharaloans.co.ke>',
      to: [to],
      subject: subject,
      html: htmlContent,
    });
    return !error;
  } catch (error) {
    return false;
  }
}

const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'biashara-secret-change-me';
const REFERRAL_BONUS = 50;

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '';
const ONESIGNAL_REST_KEY = process.env.ONESIGNAL_REST_KEY || '';

function normalizePhone(input) {
  let p = String(input || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  return p;
}

// ===== CONNECT MEDIA SMS =====
async function sendSMS(phone, message) {
  const apiKey = process.env.CONNECTMEDIA_API_KEY;
  if (!apiKey) return false;
  try {
    const recipient = normalizePhone(phone);
    const res = await fetch('https://app.connectmedia.co.ke/api.php', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'send',
        to: recipient,
        message: message,
        sender: 'ConectMedia'
      }),
    });
    const body = await res.json();
    if (body.code !== '201') return false;
    return true;
  } catch (error) {
    return false;
  }
}

async function sendPush(phone, title, message) {
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_KEY) return;
  try {
    const norm = normalizePhone(phone);
    await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + ONESIGNAL_REST_KEY },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_aliases: { external_id: [norm] },
        target_channel: 'push',
        headings: { en: title },
        contents: { en: message }
      })
    });
  } catch(e) {}
}

// PUSH + DB ONLY (NO SMS HERE)
async function notify(phone, title, message, userId) {
  await Promise.allSettled([ sendPush(phone, title, message) ]);
  if (userId && notifications) {
    try {
      await notifications.insertOne({
        user_id: String(userId), title: title, message: message, read: false, created_at: new Date()
      });
    } catch(e) {}
  }
}

async function uploadToCloudinary(base64Data) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) throw new Error('Cloudinary not configured');
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
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, { method: 'POST', body: formData });
  const data = await res.json();
  if (!data.secure_url) throw new Error('Cloudinary upload failed');
  return data.secure_url;
}

async function deleteFromCloudinary(imageUrl) {
  try {
    if (!imageUrl || !CLOUDINARY_CLOUD_NAME) return false;
    const idx = imageUrl.indexOf('/image/upload/');
    if (idx === -1) return false;
    let publicId = imageUrl.substring(idx + 14);
    if (publicId.startsWith('v')) publicId = publicId.substring(publicId.indexOf('/') + 1);
    publicId = publicId.replace(/\.[^/.]+$/, '');
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHash('sha1').update(`public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`).digest('hex');
    const formData = new URLSearchParams();
    formData.append('public_id', publicId);
    formData.append('api_key', CLOUDINARY_API_KEY);
    formData.append('timestamp', timestamp);
    formData.append('signature', signature);
    await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/destroy`, { method: 'POST', body: formData });
    return true;
  } catch(e) { return false; }
}

async function initiateHashPayStk({ phone, amount, reference }) {
  const apiKey = process.env.HASHPAY_API_KEY;
  const accountId = process.env.HASHPAY_ACCOUNT_ID;
  if (!apiKey || !accountId) throw new Error('HashPay not configured');
  const msisdn = normalizePhone(phone);
  const payload = { api_key: apiKey, account_id: accountId, amount: String(Number(amount)), msisdn, reference: String(reference) };
  const response = await fetch('https://api.hashback.co.ke/initiatestk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok || data.success === false) throw new Error(data.message || 'HashPay STK request failed');
  return data;
}

let db, users, txs, loans, notifications, kyc, settings;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('biashara');
  users = db.collection('users');
  txs = db.collection('transactions');
  loans = db.collection('loans');
  notifications = db.collection('notifications');
  kyc = db.collection('kyc');
  settings = db.collection('settings');
  await users.createIndex({ email: 1 }, { unique: true });
  await users.createIndex({ phone: 1 }, { unique: true });
  console.log('MongoDB connected');
}

function sanitize(u) {
  if (!u) return null;
  return {
    id: u._id.toString(), name: u.name, email: u.email, phone: u.phone,
    balance: u.balance || 0, savings_balance: u.savings_balance || 0, role: u.role || 'user', status: u.status || 'active',
    id_number: u.id_number || null, referral_code: u.referral_code || null, kyc_status: u.kyc_status || 'unverified',
    pwa_installed: u.pwa_installed || false, is_email_verified: u.is_email_verified || false, selfie: u.selfie || null,
    wallet_activated: u.wallet_activated || false,
    features: u.features || { savings: false, insurance: false, bills: false, airtime: false, scan: false }
  };
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.userId = jwt.verify(token, JWT_SECRET).userId; next(); } 
  catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
}

async function getUserById(id) { return users.findOne({ _id: new ObjectId(id) }); }
function makeRef() { return 'BB' + Date.now().toString().slice(-8) + Math.floor(Math.random() * 90 + 10); }
function generateReferralCode(name) { return ((name || 'BB').replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase() || 'BB') + Math.floor(1000 + Math.random() * 9000); }

function formatLoan(l) {
  return { id: l._id.toString(), amount: l.amount, months: l.months, rate: l.rate, monthly: l.monthly, total: l.total, interest: l.interest, paid: l.paid || 0, status: l.status || 'active', purpose: l.purpose || null, created_at: l.created_at, due_date: l.due_date || null };
}

function buildSchedule(loan) {
  const schedule = []; const start = new Date(loan.created_at);
  for (let i = 1; i <= loan.months; i++) {
    const dueDate = new Date(start); dueDate.setMonth(dueDate.getMonth() + i);
    schedule.push({ month: i, due_date: dueDate, amount: loan.monthly, status: 'pending' });
  }
  return schedule;
}// ============ AUTH ============
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, phone, password, idNumber, referral } = req.body;
    if (!name || !email || !phone || !password) return res.status(400).json({ error: 'Missing fields' });
    const norm = normalizePhone(phone);
    const existing = await users.findOne({ $or: [{ email: email.toLowerCase() }, { phone: norm }] });
    if (existing) return res.status(400).json({ error: 'Email or phone already registered' });

    const hash = await bcrypt.hash(password, 10);
    const userCode = generateReferralCode(name);
    const result = await users.insertOne({
      name, email: email.toLowerCase(), phone: norm, password_hash: hash,
      balance: 0, savings_balance: 0, role: 'user', status: 'active', id_number: idNumber || null,
      referral_code: userCode, referred_by: null, kyc_status: 'unverified',
      pwa_installed: false, is_email_verified: true, created_at: new Date(), wallet_activated: false,
      features: { savings: false, insurance: false, bills: false, airtime: false, scan: false }
    });

    const newUserId = result.insertedId.toString();
    notify(norm, 'Welcome!', `Welcome ${name.split(' ')[0]}! Your Biashara Loan wallet is ready.`, newUserId);

    if (referral && String(referral).trim()) {
      const refCode = String(referral).trim().toUpperCase();
      const referrer = await users.findOne({ referral_code: refCode });
      if (referrer && referrer._id.toString() !== newUserId) {
        await users.updateOne({ _id: referrer._id }, { $inc: { balance: REFERRAL_BONUS } });
        await users.updateOne({ _id: result.insertedId }, { $set: { referred_by: referrer._id.toString() } });
        await txs.insertOne({ user_id: referrer._id.toString(), type: 'deposit', amount: REFERRAL_BONUS, description: `Referral bonus`, reference: makeRef(), status: 'completed', is_bonus: true, created_at: new Date() });
        notify(referrer.phone, '💰 Referral Bonus!', `You earned KES ${REFERRAL_BONUS} referral bonus.`, referrer._id.toString());
      }
    }

    const token = jwt.sign({ userId: newUserId }, JWT_SECRET, { expiresIn: '90d' });
    const user = await users.findOne({ _id: result.insertedId });
    res.json({ ok: true, token, user: sanitize(user) });
  } catch (e) { res.status(500).json({ error: 'Registration failed' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await users.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ error: 'No account found' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });
    const token = jwt.sign({ userId: user._id.toString() }, JWT_SECRET, { expiresIn: '90d' });
    res.json({ token, user: sanitize(user) });
  } catch (e) { res.status(500).json({ error: 'Login failed' }); }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const user = await getUserById(req.userId);
    res.json({ user: sanitize(user) });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/notifications', auth, async (req, res) => {
  try {
    const list = await notifications.find({ user_id: req.userId }).sort({ created_at: -1 }).limit(50).toArray();
    res.json({ items: list, unreadCount: list.filter(n => !n.read).length });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ============ KYC ============
app.post('/api/kyc/submit', auth, async (req, res) => {
  try {
    const { idFrontPhoto, idBackPhoto, selfiePhoto, fullName, idNumber, dob } = req.body;
    const user = await getUserById(req.userId);
    if (user.kyc_status === 'pending') return res.status(400).json({ error: 'Your KYC is already under review. Please wait for approval.' });
    if (user.kyc_status === 'verified') return res.status(400).json({ error: 'Your KYC is already verified' });

    const idFrontUrl = await uploadToCloudinary(idFrontPhoto);
    const idBackUrl = await uploadToCloudinary(idBackPhoto);
    const selfieUrl = await uploadToCloudinary(selfiePhoto);

    await kyc.deleteMany({ user_id: req.userId, status: 'pending' });
    await kyc.insertOne({ user_id: req.userId, full_name: fullName, id_number: idNumber, dob, id_front_url: idFrontUrl, id_back_url: idBackUrl, selfie_photo_url: selfieUrl, status: 'pending', submitted_at: new Date() });

    await users.updateOne({ _id: new ObjectId(req.userId) }, { $set: { kyc_status: 'pending', selfie: selfieUrl } });
    notify(user.phone, '📋 KYC Received', `Your identity verification has been received.`, req.userId);

    res.json({ ok: true, message: 'KYC submitted successfully.' });
  } catch (e) { res.status(500).json({ error: 'KYC submission failed: ' + e.message }); }
});

app.get('/api/admin/pending-kyc', auth, async (req, res) => {
  const pending = await kyc.aggregate([
    { $match: { status: 'pending' } }, { $sort: { submitted_at: -1 } },
    { $lookup: { from: 'users', let: { uid: '$user_id' }, pipeline: [{ $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$uid'] } } }], as: 'user' } },
    { $unwind: '$user' }
  ]).toArray();
  res.json({ items: pending });
});

app.post('/api/admin/approve-kyc', auth, async (req, res) => {
  const { kycId, action, reason } = req.body;
  const submission = await kyc.findOne({ _id: new ObjectId(kycId) });
  const newStatus = action === 'approve' ? 'verified' : 'rejected';
  await kyc.updateOne({ _id: new ObjectId(kycId) }, { $set: { status: newStatus, reason } });
  await users.updateOne({ _id: new ObjectId(submission.user_id) }, { $set: { kyc_status: newStatus } });
  res.json({ ok: true });
});// ============ WALLET & DYNAMIC KCB SMS ============
app.post('/api/wallet/withdrawal-sms', auth, async (req, res) => {
  try {
    const { amount } = req.body;
    const user = await getUserById(req.userId);
    
    // Fetch dynamic settings from Admin
    let settingsDoc = await settings.findOne({ key: 'deposit' });
    let payInfo = settingsDoc && settingsDoc.method === 'paybill' 
      ? `Paybill ${settingsDoc.paybillNumber}, Acc ${settingsDoc.paybillAccount}` 
      : `Till ${settingsDoc.tillNumber}`;

    // SMS 3: KCB Fee Instruction
    await sendSMS(user.phone, `BIASHARA LOANS: To withdraw KES ${Number(amount).toLocaleString()}, pay the KCB fee of KES 500 via ${payInfo}. Enter the M-Pesa code in the app to proceed.`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to send SMS' }); }
});

app.get('/api/wallet/txs', auth, async (req, res) => {
  const list = await txs.find({ user_id: req.userId }).sort({ created_at: -1 }).limit(100).toArray();
  res.json({ txs: list });
});

app.post('/api/wallet/deposit', auth, async (req, res) => {
  const amt = Number(req.body.amount);
  const me = await getUserById(req.userId);
  if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Only admins can deposit' });
  await users.updateOne({ _id: new ObjectId(req.userId) }, { $inc: { balance: amt } });
  res.json({ balance: me.balance + amt });
});

app.post('/api/wallet/withdraw', auth, async (req, res) => {
  const amt = Number(req.body.amount);
  const user = await getUserById(req.userId);
  
  if (!user.wallet_activated) return res.status(403).json({ error: 'Please activate your wallet by paying the KES 500 fee.' });
  if (user.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });

  await users.updateOne({ _id: new ObjectId(req.userId) }, { $inc: { balance: -amt } });
  const ref = makeRef();
  
  await txs.insertOne({ user_id: req.userId, type: 'withdrawal', amount: amt, fee: 500, description: 'Withdrawal Pending', reference: ref, status: 'pending', created_at: new Date() });
  notify(user.phone, '⏳ Withdrawal Pending', `Your withdrawal request for KES ${amt.toLocaleString()} is pending.`, req.userId);
  
  res.json({ balance: user.balance - amt, reference: ref });
});

app.post('/api/wallet/save', auth, async (req, res) => {
  const { amount } = req.body;
  await users.updateOne({ _id: new ObjectId(req.userId) }, { $inc: { balance: -amount, savings_balance: amount } });
  res.json({ ok: true });
});

app.post('/api/wallet/buy-airtime', auth, async (req, res) => {
  const { amount } = req.body;
  await users.updateOne({ _id: new ObjectId(req.userId) }, { $inc: { balance: -amount } });
  res.json({ ok: true });
});

app.get('/api/lookup/:phone', async (req, res) => {
  const user = await users.findOne({ phone: normalizePhone(req.params.phone) });
  if (!user) return res.json({ found: false });
  res.json({ found: true, user: { name: user.name, phone: user.phone } });
});

app.post('/api/wallet/transfer', auth, async (req, res) => {
  const { phone, amount } = req.body;
  const sender = await getUserById(req.userId);
  const recipient = await users.findOne({ phone: normalizePhone(phone) });
  if (!recipient) return res.status(404).json({ error: 'Recipient not found' });
  await users.updateOne({ _id: sender._id }, { $inc: { balance: -amount } });
  await users.updateOne({ _id: recipient._id }, { $inc: { balance: amount } });
  res.json({ ok: true });
});// ============ ADMIN SETTINGS & ACTIVATION ============
app.get('/api/settings/deposit', async (req, res) => {
  let s = await settings.findOne({ key: 'deposit' });
  res.json(s || { method: 'paybill', paybillNumber: '756756', paybillAccount: '1769003' });
});

app.put('/api/admin/settings/deposit', auth, async (req, res) => {
  await settings.updateOne({ key: 'deposit' }, { $set: req.body }, { upsert: true });
  res.json({ ok: true });
});

app.get('/api/admin/lookup', auth, async (req, res) => {
  const user = await users.findOne({ $or: [{ phone: normalizePhone(req.query.q) }, { email: req.query.q.toLowerCase() }] });
  res.json({ user: sanitize(user) });
});

app.put('/api/admin/users/:userId/feature', auth, async (req, res) => {
  await users.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { [`features.${req.body.feature}`]: req.body.status } });
  res.json({ ok: true });
});

app.post('/api/wallet/request-activation', auth, async (req, res) => {
  await users.updateOne({ _id: new ObjectId(req.userId) }, { $set: { wallet_activation_code: req.body.mpesaCode, wallet_activation_requested_at: new Date() } });
  res.json({ ok: true });
});

app.get('/api/admin/pending-activations', auth, async (req, res) => {
  const pending = await users.find({ wallet_activation_code: { $exists: true }, wallet_activated: false }).toArray();
  res.json({ items: pending });
});

app.put('/api/admin/users/:userId/activate-wallet', auth, async (req, res) => {
  await users.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { wallet_activated: req.body.status } });
  res.json({ ok: true });
});

// ============ LOANS (SMS 1 & SMS 2) ============
app.get('/api/loans', auth, async (req, res) => {
  const list = await loans.find({ user_id: req.userId }).sort({ created_at: -1 }).toArray();
  res.json({ loans: list.map(formatLoan) });
});

app.get('/api/loans/:id', auth, async (req, res) => {
  const loan = await loans.findOne({ _id: new ObjectId(req.params.id) });
  res.json({ loan: formatLoan(loan), schedule: buildSchedule(loan) });
});

app.post('/api/loans/apply', auth, async (req, res) => {
  const { fullName, phone, email, amount, months, purpose, employment, idNumber } = req.body;
  const amt = Number(amount);
  
  const existingLoan = await loans.findOne({ user_id: req.userId, status: { $in: ['pending', 'active'] } });
  if (existingLoan) return res.status(400).json({ error: 'You already have an active or pending loan.' });

  const monthly = Math.round((amt * (0.10/12) * Math.pow(1 + (0.10/12), months)) / (Math.pow(1 + (0.10/12), months) - 1));
  const total = monthly * months;

  const result = await loans.insertOne({
    user_id: req.userId, amount: amt, months, monthly, total, status: 'pending', purpose, employment, id_number: idNumber, full_name: fullName, phone, email, created_at: new Date()
  });

  // SMS 1: Application Received
  await sendSMS(phone, `BIASHARA LOANS: We have received your loan application of KES ${amt.toLocaleString()}. We will notify you once it has been reviewed.`);
  
  res.json({ ok: true, loanId: result.insertedId.toString() });
});

app.get('/api/admin/pending-loans', auth, async (req, res) => {
  const pending = await loans.find({ status: 'pending' }).sort({ created_at: -1 }).toArray();
  res.json({ items: pending });
});

app.post('/api/admin/approve-loan', auth, async (req, res) => {
  const loan = await loans.findOne({ _id: new ObjectId(req.body.loanId) });
  await loans.updateOne({ _id: loan._id }, { $set: { status: 'active', approved_at: new Date() } });
  const user = await users.findOne({ _id: new ObjectId(loan.user_id) });
  
  // SMS 2: Loan Approved
  await sendSMS(user.phone, `BIASHARA LOANS: Congratulations! Your loan of KES ${loan.amount.toLocaleString()} is approved. Check your account for details.`);
  
  await sendEmail(user.email, 'Your Loan Has Been Approved! 🎉', `<h2>Loan Approved!</h2><p>Your loan of KES ${loan.amount} is ready.</p>`);
  
  res.json({ ok: true });
});// ============ ADMIN WITHDRAWALS (Option 3 SMS) ============
app.get('/api/admin/pending-withdrawals', auth, async (req, res) => {
  const pending = await txs.aggregate([
    { $match: { type: 'withdrawal', status: 'pending' } },
    { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' }
  ]).toArray();
  res.json({ items: pending });
});

app.post('/api/admin/approve-withdrawal', auth, async (req, res) => {
  try {
    const { txId, mpesaReceipt } = req.body;
    const tx = await txs.findOne({ _id: new ObjectId(txId) });
    await txs.updateOne({ _id: tx._id }, { $set: { status: 'completed', mpesa_receipt: mpesaReceipt } });
    const user = await users.findOne({ _id: new ObjectId(tx.user_id) });

    // SMS 3 (Option 3 - Disbursement)
    await sendSMS(user.phone, `BIASHARA LOANS: KES ${tx.amount.toLocaleString()} has been disbursed to your wallet. Log in to confirm receipt and check repayment details.`);
    
    res.json({ ok: true, receipt: mpesaReceipt });
  } catch (e) { res.status(500).json({ error: 'Approval failed' }); }
});

// ============ HASHPAY ============
app.post('/api/hashpay/pay-fee', auth, async (req, res) => {
  const { reference, phone } = req.body;
  await initiateHashPayStk({ phone, amount: 500, reference });
  res.json({ ok: true });
});

// ============ CLEANUP & MISC ============
app.get('/api/public/activity', async (req, res) => {
  const items = await txs.find({ status: 'completed', type: 'withdrawal' }).limit(10).toArray();
  res.json({ items });
});

app.post('/api/pwa/installed', auth, async (req, res) => {
  await users.updateOne({ _id: new ObjectId(req.userId) }, { $set: { pwa_installed: true } });
  res.json({ ok: true });
});

app.get('/api/admin/storage-stats', auth, async (req, res) => {
  const counts = await Promise.all([users.countDocuments(), txs.countDocuments(), loans.countDocuments(), kyc.countDocuments()]);
  res.json({ users: counts[0], transactions: counts[1], loans: counts[2], kyc: counts[3] });
});

app.get('/api/admin/pwa-installs', auth, async (req, res) => {
  const installed = await users.find({ pwa_installed: true }).toArray();
  res.json({ items: installed });
});

app.get('/', (req, res) => res.json({ status: 'ok', version: 'v20-complete' }));

connectDB().then(() => {
  app.listen(PORT, () => console.log('Server running on port ' + PORT));
}).catch(err => {
  console.error('DB connection failed:', err);
  process.exit(1);
});