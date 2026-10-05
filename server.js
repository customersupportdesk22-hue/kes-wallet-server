// ============================================================
// PART 1/4 — SERVER SETUP, DATABASE, AUTH & SECURITY
// ============================================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();

// ------------------------------------------------------------
// CONFIG
// ------------------------------------------------------------

const PORT = process.env.PORT || 10000;

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'biashara_boost';

const JWT_SECRET = process.env.JWT_SECRET;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is missing');
  process.exit(1);
}

if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET is missing');
  process.exit(1);
}

// ------------------------------------------------------------
// EXPRESS
// ------------------------------------------------------------

app.use(cors({
  origin: true,
  credentials: true
}));

// Capture raw webhook body for HashPay signature verification.
app.use(express.json({
  limit: '15mb',
  verify: (req, res, buf) => {
    if (req.originalUrl === '/api/hashpay/webhook') {
      req.rawBody = Buffer.from(buf);
    }
  }
}));

app.use(express.urlencoded({
  extended: true,
  limit: '15mb'
}));

// ------------------------------------------------------------
// DATABASE
// ------------------------------------------------------------

const mongoClient = new MongoClient(MONGODB_URI);

let db;
let users;
let txs;
let loans;

async function connectDB() {
  await mongoClient.connect();

  db = mongoClient.db(DB_NAME);

  users = db.collection('users');
  txs = db.collection('txs');
  loans = db.collection('loans');

  await users.createIndex(
    { phone: 1 },
    { unique: true, sparse: true }
  );

  await users.createIndex(
    { email: 1 },
    { unique: true, sparse: true }
  );

  await txs.createIndex(
    { reference: 1 },
    { unique: true, sparse: true }
  );

  await txs.createIndex({
    user_id: 1,
    created_at: -1
  });

  await loans.createIndex({
    user_id: 1,
    created_at: -1
  });

  console.log('✅ MongoDB connected');
}

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function normalizePhone(phone) {
  let p = String(phone || '').replace(/\D/g, '');

  if (p.startsWith('07') || p.startsWith('01')) {
    p = '254' + p.substring(1);
  }

  if (p.startsWith('+254')) {
    p = p.substring(1);
  }

  return p;
}

function isValidKenyanPhone(phone) {
  return /^254(7|1)\d{8}$/.test(
    normalizePhone(phone)
  );
}

function generateReference(prefix = 'BB') {
  return (
    prefix +
    Date.now().toString().slice(-8) +
    Math.floor(1000 + Math.random() * 9000)
  );
}

function signToken(userId) {
  return jwt.sign(
    {
      userId: String(userId)
    },
    JWT_SECRET,
    {
      expiresIn: '7d'
    }
  );
}

function safeUser(user) {
  if (!user) return null;

  return {
    id: String(user._id),
    name: user.name || '',
    email: user.email || '',
    phone: user.phone || '',
    role: user.role || 'customer',
    balance: Number(user.balance || 0),
    status: user.status || 'active'
  };
}

// ------------------------------------------------------------
// AUTH MIDDLEWARE
// ------------------------------------------------------------

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';

    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Authentication required'
      });
    }

    const token = header.substring(7);

    const decoded = jwt.verify(
      token,
      JWT_SECRET
    );

    const user = await users.findOne({
      _id: new ObjectId(decoded.userId)
    });

    if (!user) {
      return res.status(401).json({
        error: 'User not found'
      });
    }

    if (user.status === 'blocked') {
      return res.status(403).json({
        error: 'Account blocked'
      });
    }

    req.userId = String(user._id);
    req.user = user;

    next();

  } catch (error) {
    console.error('Auth error:', error.message);

    return res.status(401).json({
      error: 'Invalid or expired token'
    });
  }
}

async function adminAuth(req, res, next) {
  await auth(req, res, async () => {
    if (
      req.user.role !== 'admin' &&
      req.user.role !== 'administrator'
    ) {
      return res.status(403).json({
        error: 'Administrator access required'
      });
    }

    next();
  });
}

// ------------------------------------------------------------
// HEALTH
// ------------------------------------------------------------

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'Biashara Boost Loans API',
    status: 'online',
    time: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    database: !!db,
    time: new Date().toISOString()
  });
});

// ------------------------------------------------------------
// REGISTER
// ------------------------------------------------------------

app.post('/api/auth/register', async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password,
      pin
    } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({
        error: 'Name, phone and password are required'
      });
    }

    const cleanPhone = normalizePhone(phone);

    if (!isValidKenyanPhone(cleanPhone)) {
      return res.status(400).json({
        error: 'Invalid Kenyan phone number'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters'
      });
    }

    const existingPhone = await users.findOne({
      phone: cleanPhone
    });

    if (existingPhone) {
      return res.status(409).json({
        error: 'Phone number already registered'
      });
    }

    if (email) {
      const existingEmail = await users.findOne({
        email: String(email).toLowerCase()
      });

      if (existingEmail) {
        return res.status(409).json({
          error: 'Email already registered'
        });
      }
    }

    const passwordHash = await bcrypt.hash(
      password,
      12
    );

    const pinHash = pin
      ? await bcrypt.hash(String(pin), 10)
      : null;

    const user = {
      name: String(name).trim(),
      email: email
        ? String(email).trim().toLowerCase()
        : '',
      phone: cleanPhone,
      password_hash: passwordHash,
      pin: pinHash,
      role: 'customer',
      balance: 0,
      status: 'active',
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await users.insertOne(user);

    const token = signToken(result.insertedId);

    res.status(201).json({
      ok: true,
      token,
      user: safeUser({
        ...user,
        _id: result.insertedId
      })
    });

  } catch (error) {
    console.error('Register error:', error);

    res.status(500).json({
      error: 'Registration failed'
    });
  }
});

// ------------------------------------------------------------
// LOGIN
// ------------------------------------------------------------

app.post('/api/auth/login', async (req, res) => {
  try {
    const {
      phone,
      email,
      password
    } = req.body;

    if ((!phone && !email) || !password) {
      return res.status(400).json({
        error: 'Phone/email and password are required'
      });
    }

    const query = phone
      ? { phone: normalizePhone(phone) }
      : { email: String(email).toLowerCase() };

    const user = await users.findOne(query);

    if (!user) {
      return res.status(401).json({
        error: 'Invalid login details'
      });
    }

    const valid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        error: 'Invalid login details'
      });
    }

    if (user.status === 'blocked') {
      return res.status(403).json({
        error: 'Account blocked'
      });
    }

    const token = signToken(user._id);

    res.json({
      ok: true,
      token,
      user: safeUser(user)
    });

  } catch (error) {
    console.error('Login error:', error);

    res.status(500).json({
      error: 'Login failed'
    });
  }
});

// ------------------------------------------------------------
// CURRENT USER
// ------------------------------------------------------------

app.get('/api/auth/me', auth, async (req, res) => {
  res.json({
    ok: true,
    user: safeUser(req.user)
  });
});// ============================================================
// PART 2/4 — WALLET, LOANS & WITHDRAWALS
// ============================================================

// ------------------------------------------------------------
// WALLET
// ------------------------------------------------------------

app.get('/api/wallet', auth, async (req, res) => {
  try {
    const user = await users.findOne({
      _id: new ObjectId(req.userId)
    });

    const transactions = await txs.find({
      user_id: req.userId
    })
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();

    res.json({
      ok: true,
      balance: Number(user.balance || 0),
      transactions
    });

  } catch (error) {
    console.error('Wallet error:', error);

    res.status(500).json({
      error: 'Could not load wallet'
    });
  }
});

// ------------------------------------------------------------
// TRANSACTIONS
// ------------------------------------------------------------

app.get('/api/transactions', auth, async (req, res) => {
  try {
    const transactions = await txs.find({
      user_id: req.userId
    })
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();

    res.json({
      ok: true,
      transactions
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Could not load transactions'
    });
  }
});

// ------------------------------------------------------------
// LOAN APPLICATION
// ------------------------------------------------------------

app.post('/api/loans/apply', auth, async (req, res) => {
  try {
    const {
      amount,
      purpose,
      duration
    } = req.body;

    const loanAmount = Number(amount);

    const allowedAmounts = [
      2000,
      5000,
      10000,
      20000,
      50000
    ];

    if (!allowedAmounts.includes(loanAmount)) {
      return res.status(400).json({
        error: 'Invalid loan amount'
      });
    }

    const existing = await loans.findOne({
      user_id: req.userId,
      status: {
        $in: [
          'pending',
          'approved',
          'processing'
        ]
      }
    });

    if (existing) {
      return res.status(400).json({
        error: 'You already have an active loan application'
      });
    }

    const loan = {
      user_id: req.userId,
      amount: loanAmount,
      purpose: purpose || '',
      duration: Number(duration || 30),
      status: 'pending',
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await loans.insertOne(loan);

    res.json({
      ok: true,
      message: 'Loan application submitted',
      loan: {
        ...loan,
        _id: result.insertedId
      }
    });

  } catch (error) {
    console.error('Loan apply error:', error);

    res.status(500).json({
      error: 'Could not submit loan application'
    });
  }
});

// ------------------------------------------------------------
// MY LOANS
// ------------------------------------------------------------

app.get('/api/loans', auth, async (req, res) => {
  try {
    const result = await loans.find({
      user_id: req.userId
    })
      .sort({ created_at: -1 })
      .toArray();

    res.json({
      ok: true,
      loans: result
    });

  } catch (error) {
    res.status(500).json({
      error: 'Could not load loans'
    });
  }
});

// ------------------------------------------------------------
// FEE CALCULATION
// ------------------------------------------------------------

function calculateFee(amount) {
  const n = Number(amount);

  if (n <= 2000) return 200;
  if (n <= 5000) return 400;
  if (n <= 10000) return 600;
  if (n <= 20000) return 800;
  if (n <= 50000) return 1000;

  return 1500;
}

// ------------------------------------------------------------
// WITHDRAWAL REQUEST
// ------------------------------------------------------------

app.post('/api/wallet/withdraw', auth, async (req, res) => {
  try {
    const {
      amount,
      phone
    } = req.body;

    const withdrawalAmount = Number(amount);

    if (!withdrawalAmount || withdrawalAmount <= 0) {
      return res.status(400).json({
        error: 'Invalid withdrawal amount'
      });
    }

    const cleanPhone = normalizePhone(
      phone || req.user.phone
    );

    if (!isValidKenyanPhone(cleanPhone)) {
      return res.status(400).json({
        error: 'Invalid M-Pesa phone number'
      });
    }

    const user = await users.findOne({
      _id: new ObjectId(req.userId)
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    const balance = Number(user.balance || 0);

    if (balance < withdrawalAmount) {
      return res.status(400).json({
        error: 'Insufficient wallet balance'
      });
    }

    const reference = generateReference('BB');

    const fee = calculateFee(withdrawalAmount);

    const transaction = {
      user_id: req.userId,
      type: 'withdrawal',
      amount: withdrawalAmount,
      fee,
      phone: cleanPhone,
      mpesa_phone: cleanPhone,
      reference,
      status: 'pending',
      fee_paid: false,
      created_at: new Date(),
      updated_at: new Date(),
      description: 'M-Pesa withdrawal'
    };

    // Deduct the wallet amount atomically.
    const update = await users.updateOne(
      {
        _id: new ObjectId(req.userId),
        balance: {
          $gte: withdrawalAmount
        }
      },
      {
        $inc: {
          balance: -withdrawalAmount
        },
        $set: {
          updated_at: new Date()
        }
      }
    );

    if (update.modifiedCount !== 1) {
      return res.status(400).json({
        error: 'Balance changed. Please try again.'
      });
    }

    const result = await txs.insertOne(
      transaction
    );

    res.json({
      ok: true,
      message: 'Withdrawal request created',
      reference,
      amount: withdrawalAmount,
      fee,
      phone: cleanPhone,
      transaction_id: String(result.insertedId)
    });

  } catch (error) {
    console.error('Withdrawal error:', error);

    res.status(500).json({
      error: 'Could not create withdrawal'
    });
  }
});

// ------------------------------------------------------------
// CANCEL PENDING WITHDRAWAL
// ------------------------------------------------------------

app.post(
  '/api/wallet/withdraw/:reference/cancel',
  auth,
  async (req, res) => {
    try {
      const tx = await txs.findOne({
        reference: req.params.reference,
        user_id: req.userId,
        type: 'withdrawal'
      });

      if (!tx) {
        return res.status(404).json({
          error: 'Withdrawal not found'
        });
      }

      if (
        tx.status !== 'pending' ||
        tx.fee_paid
      ) {
        return res.status(400).json({
          error: 'Withdrawal cannot be cancelled'
        });
      }

      await txs.updateOne(
        { _id: tx._id },
        {
          $set: {
            status: 'cancelled',
            updated_at: new Date()
          }
        }
      );

      await users.updateOne(
        {
          _id: new ObjectId(req.userId)
        },
        {
          $inc: {
            balance: Number(tx.amount)
          },
          $set: {
            updated_at: new Date()
          }
        }
      );

      res.json({
        ok: true,
        message: 'Withdrawal cancelled and balance restored'
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: 'Could not cancel withdrawal'
      });
    }
  }
);

// ------------------------------------------------------------
// USER WITHDRAWAL DETAILS
// ------------------------------------------------------------

app.get(
  '/api/wallet/withdraw/:reference',
  auth,
  async (req, res) => {
    try {
      const tx = await txs.findOne({
        reference: req.params.reference,
        user_id: req.userId,
        type: 'withdrawal'
      });

      if (!tx) {
        return res.status(404).json({
          error: 'Withdrawal not found'
        });
      }

      res.json({
        ok: true,
        transaction: tx
      });

    } catch (error) {
      res.status(500).json({
        error: 'Could not load withdrawal'
      });
    }
  }
);// ============================================================
// PART 3/4 — HASHPAY STK PUSH, STATUS & WEBHOOK
// ============================================================

// IMPORTANT:
// HashPay's current STK endpoint expects:
// api_key
// account_id
// amount
// msisdn
// reference
//
// It does NOT use "phone" for this endpoint.
// It does NOT require callback_url in the STK payload.
//
// Configure the webhook URL in your HashPay dashboard:
// https://YOUR-DOMAIN/api/hashpay/webhook
// ============================================================

function getHashPayConfig() {
  const apiKey = process.env.HASHPAY_API_KEY;
  const accountId = process.env.HASHPAY_ACCOUNT_ID;

  if (!apiKey || !accountId) {
    throw new Error(
      'HashPay is not configured. Set HASHPAY_API_KEY and HASHPAY_ACCOUNT_ID.'
    );
  }

  return {
    apiKey,
    accountId
  };
}

// ------------------------------------------------------------
// HASH PAY STK
// ------------------------------------------------------------

async function initiateHashPayStk({
  phone,
  amount,
  reference
}) {
  const {
    apiKey,
    accountId
  } = getHashPayConfig();

  const msisdn = normalizePhone(phone);

  if (!isValidKenyanPhone(msisdn)) {
    throw new Error(
      'Invalid Kenyan M-Pesa number'
    );
  }

  const numericAmount = Number(amount);

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount <= 0
  ) {
    throw new Error(
      'Invalid HashPay amount'
    );
  }

  const payload = {
    api_key: apiKey,
    account_id: accountId,
    amount: String(numericAmount),
    msisdn: msisdn,
    reference: String(reference)
  };

  console.log(
    '=== HASHPAY STK PUSH ==='
  );

  console.log(
    'Account:',
    accountId
  );

  console.log(
    'MSISDN:',
    msisdn
  );

  console.log(
    'Amount:',
    payload.amount
  );

  console.log(
    'Reference:',
    reference
  );

  // NEVER log the API key.

  const response = await fetch(
    'https://api.hashback.co.ke/initiatestk',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `HashPay returned invalid JSON: ${text.substring(0, 300)}`
    );
  }

  console.log(
    'HashPay HTTP:',
    response.status
  );

  console.log(
    'HashPay response:',
    JSON.stringify(data)
  );

  if (!response.ok) {
    throw new Error(
      data.message ||
      data.error ||
      `HashPay HTTP ${response.status}`
    );
  }

  if (data.success === false) {
    throw new Error(
      data.message ||
      data.error?.message ||
      'HashPay STK request failed'
    );
  }

  return data;
}

// ------------------------------------------------------------
// PAY WITHDRAWAL FEE
// ------------------------------------------------------------

app.post(
  '/api/hashpay/pay-fee',
  auth,
  async (req, res) => {
    try {
      const {
        reference,
        phone
      } = req.body;

      if (!reference || !phone) {
        return res.status(400).json({
          error:
            'Missing reference or phone number'
        });
      }

      const tx = await txs.findOne({
        reference: String(reference),
        user_id: req.userId,
        type: 'withdrawal'
      });

      if (!tx) {
        return res.status(404).json({
          error: 'Withdrawal not found'
        });
      }

      if (tx.status === 'cancelled') {
        return res.status(400).json({
          error: 'Withdrawal has been cancelled'
        });
      }

      if (tx.fee_paid) {
        return res.status(400).json({
          error: 'Payment has already been completed'
        });
      }

      const cleanPhone = normalizePhone(phone);

      if (!isValidKenyanPhone(cleanPhone)) {
        return res.status(400).json({
          error:
            'Invalid M-Pesa number. Use 07XX XXX XXX or 01XX XXX XXX'
        });
      }

      const fee = Number(
        tx.fee || calculateFee(tx.amount)
      );

      const hpResponse =
        await initiateHashPayStk({
          phone: cleanPhone,
          amount: fee,
          reference: reference
        });

      const checkoutId =
        hpResponse.checkout_id ||
        hpResponse.CheckoutRequestID ||
        hpResponse.checkoutId ||
        null;

      await txs.updateOne(
        {
          _id: tx._id
        },
        {
          $set: {
            mpesa_phone: cleanPhone,
            hashpay_stk_at: new Date(),
            hashpay_stk_response:
              hpResponse,
            hashpay_checkout_id:
              checkoutId,
            fee,
            updated_at: new Date()
          }
        }
      );

      res.json({
        ok: true,
        message:
          `M-Pesa prompt sent to ${cleanPhone}. Enter your M-Pesa PIN to complete the payment.`,
        phone: cleanPhone,
        fee,
        reference,
        checkout_id: checkoutId,
        hashpay: hpResponse
      });

    } catch (error) {
      console.error(
        'HashPay pay-fee error:',
        error
      );

      res.status(500).json({
        error:
          'Could not send M-Pesa request: ' +
          error.message
      });
    }
  }
);

// ------------------------------------------------------------
// HASH PAY STATUS
// ------------------------------------------------------------

async function checkHashPayStatus(
  checkoutId
) {
  const {
    apiKey,
    accountId
  } = getHashPayConfig();

  if (!checkoutId) {
    throw new Error(
      'Missing HashPay checkout ID'
    );
  }

  const payload = {
    api_key: apiKey,
    account_id: accountId,
    checkoutid: String(checkoutId)
  };

  const response = await fetch(
    'https://api.hashback.co.ke/transactionstatus',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      'HashPay status returned invalid JSON'
    );
  }

  console.log(
    'HashPay status:',
    JSON.stringify(data)
  );

  return data;
}

// ------------------------------------------------------------
// CHECK PAYMENT STATUS
// ------------------------------------------------------------

app.get(
  '/api/hashpay/status/:reference',
  auth,
  async (req, res) => {
    try {
      const tx = await txs.findOne({
        reference: req.params.reference,
        user_id: req.userId,
        type: 'withdrawal'
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
          status: 'completed',
          reference: tx.reference
        });
      }

      const checkoutId =
        tx.hashpay_checkout_id;

      if (!checkoutId) {
        return res.json({
          ok: true,
          paid: false,
          status: 'pending',
          reference: tx.reference,
          message:
            'HashPay checkout ID is not available yet'
        });
      }

      const result =
        await checkHashPayStatus(
          checkoutId
        );

      const resultCode =
        result.ResultCode !== undefined
          ? String(result.ResultCode)
          : result.ResponseCode !== undefined
            ? String(result.ResponseCode)
            : null;

      const paid =
        resultCode === '0';

      if (paid && !tx.fee_paid) {
        const receipt =
          result.TransactionReceipt ||
          result.TransactionID ||
          result.transaction_id ||
          null;

        await txs.updateOne(
          {
            _id: tx._id
          },
          {
            $set: {
              fee_paid: true,
              fee_paid_at: new Date(),
              fee_receipt: receipt,
              fee_amount:
                Number(
                  result.TransactionAmount ||
                  tx.fee ||
                  0
                ),
              updated_at: new Date()
            }
          }
        );
      }

      res.json({
        ok: true,
        paid,
        status:
          paid
            ? 'completed'
            : 'pending',
        checkout_id: checkoutId,
        reference: tx.reference,
        hashpay: result
      });

    } catch (error) {
      console.error(
        'HashPay status error:',
        error
      );

      res.status(500).json({
        error:
          'Failed to check payment status'
      });
    }
  }
);

// ------------------------------------------------------------
// HASH PAY WEBHOOK SIGNATURE
// ------------------------------------------------------------

function verifyHashPaySignature(
  rawBody,
  signature
) {
  try {
    const secret =
      process.env.HASHPAY_WEBHOOK_SECRET ||
      process.env.HASHPAY_API_KEY;

    if (!secret || !signature) {
      return false;
    }

    const received =
      String(signature)
        .replace(/^sha256=/i, '')
        .trim();

    const expected =
      crypto
        .createHmac(
          'sha256',
          secret
        )
        .update(rawBody)
        .digest('hex');

    const receivedBuffer =
      Buffer.from(received, 'utf8');

    const expectedBuffer =
      Buffer.from(expected, 'utf8');

    if (
      receivedBuffer.length !==
      expectedBuffer.length
    ) {
      return false;
    }

    return crypto.timingSafeEqual(
      receivedBuffer,
      expectedBuffer
    );

  } catch (error) {
    console.error(
      'HashPay signature error:',
      error.message
    );

    return false;
  }
}

// ------------------------------------------------------------
// HASH PAY WEBHOOK
// ------------------------------------------------------------

app.post(
  '/api/hashpay/webhook',
  async (req, res) => {
    try {
      const rawBody =
        req.rawBody ||
        Buffer.from(
          JSON.stringify(req.body || {})
        );

      const signature =
        req.headers['x-hashpay-signature'] ||
        req.headers['x-hashback-signature'];

      console.log(
        '=== HASHPAY WEBHOOK ==='
      );

      console.log(
        'Signature received:',
        !!signature
      );

      // If you configure the webhook secret,
      // signature verification is enforced.
      if (
        process.env.HASHPAY_WEBHOOK_SECRET
      ) {
        if (!signature) {
          return res.status(401).json({
            error:
              'Missing webhook signature'
          });
        }

        const valid =
          verifyHashPaySignature(
            rawBody,
            signature
          );

        if (!valid) {
          console.warn(
            '⚠️ Invalid HashPay webhook signature'
          );

          return res.status(401).json({
            error:
              'Invalid signature'
          });
        }
      }

      const body =
        req.body || {};

      console.log(
        'Webhook event:',
        body.event
      );

      console.log(
        'Webhook reference:',
        body.TransactionReference
      );

      const ref =
        body.TransactionReference ||
        body.reference ||
        body.transaction_reference;

      const receipt =
        body.TransactionReceipt ||
        body.TransactionID ||
        body.transaction_id ||
        body.MpesaReceipt ||
        null;

      const amount =
        Number(
          body.TransactionAmount ||
          body.amount ||
          0
        );

      const responseCode =
        body.ResponseCode !== undefined
          ? Number(body.ResponseCode)
          : 0;

      if (!ref) {
        return res.status(400).json({
          error:
            'Missing TransactionReference'
        });
      }

      if (responseCode !== 0) {
        console.log(
          'HashPay payment not successful:',
          responseCode
        );

        return res.json({
          ok: true,
          ignored: true
        });
      }

      const tx =
        await txs.findOne({
          reference: String(ref),
          type: 'withdrawal'
        });

      if (!tx) {
        console.warn(
          'No matching withdrawal:',
          ref
        );

        return res.json({
          ok: true,
          ignored: true
        });
      }

      if (tx.fee_paid) {
        return res.json({
          ok: true,
          already: true
        });
      }

      await txs.updateOne(
        {
          _id: tx._id
        },
        {
          $set: {
            fee_paid: true,
            fee_paid_at: new Date(),
            fee_receipt: receipt,
            fee_amount: amount,
            updated_at: new Date(),
            description:
              'M-Pesa payment received — awaiting withdrawal processing'
          }
        }
      );

      console.log(
        '✅ HashPay payment marked paid:',
        ref
      );

      res.json({
        ok: true
      });

    } catch (error) {
      console.error(
        'HashPay webhook error:',
        error
      );

      res.status(500).json({
        error:
          'Webhook processing failed'
      });
    }
  }
);// ============================================================
// PART 4/4 — ADMIN, B2C PAYOUT & SERVER STARTUP
// ============================================================

// ------------------------------------------------------------
// ADMIN — USERS
// ------------------------------------------------------------

app.get(
  '/api/admin/users',
  adminAuth,
  async (req, res) => {
    try {
      const result =
        await users.find(
          {},
          {
            projection: {
              password_hash: 0,
              pin: 0
            }
          }
        )
        .sort({ created_at: -1 })
        .limit(500)
        .toArray();

      res.json({
        ok: true,
        users: result
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: 'Could not load users'
      });
    }
  }
);

// ------------------------------------------------------------
// ADMIN — ALL WITHDRAWALS
// ------------------------------------------------------------

app.get(
  '/api/admin/withdrawals',
  adminAuth,
  async (req, res) => {
    try {
      const result =
        await txs.find({
          type: 'withdrawal'
        })
        .sort({
          created_at: -1
        })
        .limit(500)
        .toArray();

      res.json({
        ok: true,
        withdrawals: result
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Could not load withdrawals'
      });
    }
  }
);

// ------------------------------------------------------------
// ADMIN — ALL LOANS
// ------------------------------------------------------------

app.get(
  '/api/admin/loans',
  adminAuth,
  async (req, res) => {
    try {
      const result =
        await loans.find({})
          .sort({
            created_at: -1
          })
          .limit(500)
          .toArray();

      res.json({
        ok: true,
        loans: result
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: 'Could not load loans'
      });
    }
  }
);

// ------------------------------------------------------------
// ADMIN — APPROVE LOAN
// ------------------------------------------------------------

app.post(
  '/api/admin/loans/:id/approve',
  adminAuth,
  async (req, res) => {
    try {
      const id =
        new ObjectId(req.params.id);

      const loan =
        await loans.findOne({
          _id: id
        });

      if (!loan) {
        return res.status(404).json({
          error: 'Loan not found'
        });
      }

      await loans.updateOne(
        {
          _id: id
        },
        {
          $set: {
            status: 'approved',
            approved_at: new Date(),
            approved_by:
              req.userId,
            updated_at: new Date()
          }
        }
      );

      res.json({
        ok: true,
        message:
          'Loan approved'
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Could not approve loan'
      });
    }
  }
);

// ------------------------------------------------------------
// HASHPAY B2C WITHDRAWAL
// ------------------------------------------------------------
//
// IMPORTANT:
// This is the REAL payout endpoint.
// Do not mark a withdrawal "completed" merely because
// an administrator clicked Approve.
//
// Configure:
// HASHPAY_API_KEY
// HASHPAY_ACCOUNT_ID
// HASHPAY_SECURITY_CREDENTIAL
//
// HashPay's current B2C endpoint:
// POST /V2/processwithdrawal
// ------------------------------------------------------------

async function processHashPayWithdrawal({
  phone,
  amount
}) {
  const apiKey =
    process.env.HASHPAY_API_KEY;

  const securityCredential =
    process.env.HASHPAY_SECURITY_CREDENTIAL;

  if (!apiKey) {
    throw new Error(
      'HASHPAY_API_KEY is missing'
    );
  }

  if (!securityCredential) {
    throw new Error(
      'HASHPAY_SECURITY_CREDENTIAL is missing'
    );
  }

  const msisdn =
    normalizePhone(phone);

  if (!isValidKenyanPhone(msisdn)) {
    throw new Error(
      'Invalid payout phone number'
    );
  }

  const payoutAmount =
    Number(amount);

  if (
    !Number.isFinite(payoutAmount) ||
    payoutAmount <= 0
  ) {
    throw new Error(
      'Invalid payout amount'
    );
  }

  const payload = {
    api_key: apiKey,
    msisdn: msisdn,
    amount: String(payoutAmount),
    SecurityCredential:
      securityCredential
  };

  console.log(
    '=== HASHPAY B2C PAYOUT ==='
  );

  console.log(
    'MSISDN:',
    msisdn
  );

  console.log(
    'Amount:',
    payoutAmount
  );

  const response =
    await fetch(
      'https://api.hashback.co.ke/V2/processwithdrawal',
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json',
          'Accept':
            'application/json'
        },
        body:
          JSON.stringify(payload)
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      'HashPay B2C returned invalid JSON'
    );
  }

  console.log(
    'HashPay B2C HTTP:',
    response.status
  );

  console.log(
    'HashPay B2C response:',
    JSON.stringify(data)
  );

  if (!response.ok) {
    throw new Error(
      data.message ||
      data.error ||
      `HashPay HTTP ${response.status}`
    );
  }

  if (data.success === false) {
    throw new Error(
      data.message ||
      'HashPay payout failed'
    );
  }

  return data;
}

// ------------------------------------------------------------
// ADMIN — RELEASE WITHDRAWAL
// ------------------------------------------------------------

app.post(
  '/api/admin/withdrawals/:reference/release',
  adminAuth,
  async (req, res) => {
    try {
      const reference =
        String(req.params.reference);

      const tx =
        await txs.findOne({
          reference,
          type: 'withdrawal'
        });

      if (!tx) {
        return res.status(404).json({
          error:
            'Withdrawal not found'
        });
      }

      if (tx.status === 'completed') {
        return res.status(400).json({
          error:
            'Withdrawal already completed'
        });
      }

      if (tx.status === 'cancelled') {
        return res.status(400).json({
          error:
            'Withdrawal is cancelled'
        });
      }

      // Payment/fee must be genuinely confirmed
      // before payout is processed.
      if (!tx.fee_paid) {
        return res.status(400).json({
          error:
            'Payment has not been confirmed'
        });
      }

      const phone =
        tx.mpesa_phone ||
        tx.phone;

      const payout =
        await processHashPayWithdrawal({
          phone,
          amount: tx.amount
        });

      // Only now do we mark it completed.
      await txs.updateOne(
        {
          _id: tx._id
        },
        {
          $set: {
            status: 'completed',
            payout_at: new Date(),
            payout_response:
              payout,
            payout_phone:
              normalizePhone(phone),
            payout_amount:
              Number(tx.amount),
            updated_at: new Date()
          }
        }
      );

      res.json({
        ok: true,
        message:
          'Withdrawal payout request submitted',
        reference,
        amount:
          Number(tx.amount),
        phone:
          normalizePhone(phone),
        payout
      });

    } catch (error) {
      console.error(
        'B2C payout error:',
        error
      );

      // IMPORTANT:
      // Do NOT mark the withdrawal completed
      // when the actual payout fails.

      res.status(500).json({
        error:
          'M-Pesa payout was not completed: ' +
          error.message
      });
    }
  }
);

// ------------------------------------------------------------
// ADMIN — REJECT WITHDRAWAL
// ------------------------------------------------------------

app.post(
  '/api/admin/withdrawals/:reference/reject',
  adminAuth,
  async (req, res) => {
    try {
      const reference =
        String(req.params.reference);

      const tx =
        await txs.findOne({
          reference,
          type: 'withdrawal'
        });

      if (!tx) {
        return res.status(404).json({
          error:
            'Withdrawal not found'
        });
      }

      if (
        tx.status === 'completed' ||
        tx.status === 'cancelled'
      ) {
        return res.status(400).json({
          error:
            'Withdrawal cannot be rejected'
        });
      }

      await txs.updateOne(
        {
          _id: tx._id
        },
        {
          $set: {
            status: 'cancelled',
            rejected_at: new Date(),
            rejected_by:
              req.userId,
            updated_at: new Date()
          }
        }
      );

      // Return withdrawn amount to wallet.
      await users.updateOne(
        {
          _id:
            new ObjectId(
              tx.user_id
            )
        },
        {
          $inc: {
            balance:
              Number(tx.amount)
          },
          $set: {
            updated_at:
              new Date()
          }
        }
      );

      res.json({
        ok: true,
        message:
          'Withdrawal rejected and wallet balance restored'
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Could not reject withdrawal'
      });
    }
  }
);

// ------------------------------------------------------------
// 404
// ------------------------------------------------------------

app.use(
  (req, res) => {
    res.status(404).json({
      error: 'API endpoint not found',
      path: req.originalUrl
    });
  }
);

// ------------------------------------------------------------
// ERROR HANDLER
// ------------------------------------------------------------

app.use(
  (error, req, res, next) => {
    console.error(
      'Unhandled server error:',
      error
    );

    res.status(500).json({
      error:
        'Internal server error'
    });
  }
);

// ------------------------------------------------------------
// START
// ------------------------------------------------------------

async function startServer() {
  try {
    await connectDB();

    app.listen(
      PORT,
      '0.0.0.0',
      () => {
        console.log(
          `🚀 Server running on port ${PORT}`
        );

        console.log(
          `🌐 Environment: ${
            process.env.NODE_ENV || 'production'
          }`
        );

        console.log(
          '✅ MongoDB ready'
        );

        console.log(
          '✅ HashPay integration loaded'
        );

        console.log(
          '✅ Server started successfully'
        );
      }
    );

  } catch (error) {
    console.error(
      '❌ Server startup failed:',
      error
    );

    process.exit(1);
  }
}