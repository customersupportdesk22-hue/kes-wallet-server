// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

const JWT_SECRET =
  process.env.JWT_SECRET || 'change-me-please-abc123';


// ======================================================
// DATABASE INITIALIZATION
// ======================================================

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      pin TEXT,
      role TEXT DEFAULT 'customer',
      balance NUMERIC(14,2) DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS txs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      type TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      status TEXT DEFAULT 'pending',
      reference TEXT,
      description TEXT,
      counterparty TEXT,
      mpesa_receipt TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Permanent activation timestamp for Live Payouts
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await pool.query(`
    INSERT INTO app_settings (key, value)
    VALUES ('live_payouts_start', NOW()::text)
    ON CONFLICT (key) DO NOTHING;
  `);

  console.log('Database initialized successfully.');
}


// ======================================================
// AUTH
// ======================================================

function auth(req, res, next) {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Authentication required'
    });
  }

  const token = header.slice(7);

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({
      error: 'Invalid or expired token'
    });
  }
}


// ======================================================
// REGISTER
// ======================================================

app.post('/api/register', async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password,
      pin
    } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        error: 'Name, email and password are required'
      });
    }

    const existing = await pool.query(
      `SELECT id
       FROM users
       WHERE email = $1 OR phone = $2
       LIMIT 1`,
      [email, phone || null]
    );

    if (existing.rows.length) {
      return res.status(400).json({
        error: 'User already exists'
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users
       (name, email, phone, password_hash, pin, role, balance, status)
       VALUES ($1,$2,$3,$4,$5,'customer',0,'active')
       RETURNING id,name,email,phone,role,balance,status,created_at`,
      [
        name,
        email,
        phone || null,
        passwordHash,
        pin || null
      ]
    );

    const user = result.rows[0];

    const token = jwt.sign(
      {
        id: user.id,
        role: user.role
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Registration failed'
    });
  }
});


// ======================================================
// LOGIN
// ======================================================

app.post('/api/login', async (req, res) => {
  try {
    const {
      email,
      password
    } = req.body;

    const result = await pool.query(
      `SELECT *
       FROM users
       WHERE email = $1
       LIMIT 1`,
      [email]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        error: 'Invalid email or password'
      });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        error: 'Invalid email or password'
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        error: 'Account is not active'
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        role: user.role
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        balance: user.balance,
        status: user.status,
        created_at: user.created_at
      }
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Login failed'
    });
  }
});


// ======================================================
// ME
// ======================================================

app.get('/api/me', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT
        id,
        name,
        email,
        phone,
        role,
        balance,
        status,
        created_at
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (!r.rows.length) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    res.json(r.rows[0]);

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Could not load user'
    });
  }
});


// ======================================================
// USER LOOKUP
// ======================================================

app.get('/api/users/lookup', auth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();

    if (!q) {
      return res.status(400).json({
        error: 'Search value required'
      });
    }

    const r = await pool.query(
      `SELECT id,name,email,phone
       FROM users
       WHERE email = $1 OR phone = $1
       LIMIT 1`,
      [q]
    );

    if (!r.rows.length) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    res.json(r.rows[0]);

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Lookup failed'
    });
  }
});


// ======================================================
// WALLET
// ======================================================

app.get('/api/wallet', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT balance
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (!r.rows.length) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    res.json({
      balance: Number(r.rows[0].balance)
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Could not load wallet'
    });
  }
});


// ======================================================
// TRANSACTIONS
// ======================================================

app.get('/api/txs', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT *
       FROM txs
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json({
      items: r.rows
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Could not load transactions'
    });
  }
});


// ======================================================
// DEPOSIT
// ======================================================

app.post('/api/deposit', auth, async (req, res) => {
  const client = await pool.connect();

  try {
    const amount = Number(req.body.amount);

    if (!amount || amount <= 0) {
      return res.status(400).json({
        error: 'Invalid amount'
      });
    }

    await client.query('BEGIN');

    await client.query(
      `UPDATE users
       SET balance = balance + $1
       WHERE id = $2`,
      [amount, req.user.id]
    );

    const tx = await client.query(
      `INSERT INTO txs
       (user_id,type,amount,status,description)
       VALUES ($1,'deposit',$2,'completed','Wallet deposit')
       RETURNING *`,
      [req.user.id, amount]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      transaction: tx.rows[0]
    });

  } catch (e) {
    await client.query('ROLLBACK');

    console.error(e);

    res.status(500).json({
      error: 'Deposit failed'
    });

  } finally {
    client.release();
  }
});


// ======================================================
// WITHDRAW
// ======================================================

app.post('/api/withdraw', auth, async (req, res) => {
  const client = await pool.connect();

  try {
    const amount = Number(req.body.amount);

    if (!amount || amount <= 0) {
      return res.status(400).json({
        error: 'Invalid amount'
      });
    }

    await client.query('BEGIN');

    const userResult = await client.query(
      `SELECT balance
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [req.user.id]
    );

    if (!userResult.rows.length) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'User not found'
      });
    }

    const balance = Number(userResult.rows[0].balance);

    if (balance < amount) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        error: 'Insufficient balance'
      });
    }

    await client.query(
      `UPDATE users
       SET balance = balance - $1
       WHERE id = $2`,
      [amount, req.user.id]
    );

    const tx = await client.query(
      `INSERT INTO txs
       (user_id,type,amount,status,description)
       VALUES ($1,'withdrawal',$2,'completed','Wallet withdrawal')
       RETURNING *`,
      [req.user.id, amount]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      transaction: tx.rows[0]
    });

  } catch (e) {
    await client.query('ROLLBACK');

    console.error(e);

    res.status(500).json({
      error: 'Withdrawal failed'
    });

  } finally {
    client.release();
  }
});


// ======================================================
// TRANSFER
// ======================================================

app.post('/api/transfer', auth, async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      recipientId,
      amount
    } = req.body;

    const value = Number(amount);

    if (!recipientId || !value || value <= 0) {
      return res.status(400).json({
        error: 'Invalid transfer'
      });
    }

    if (Number(recipientId) === Number(req.user.id)) {
      return res.status(400).json({
        error: 'Cannot transfer to yourself'
      });
    }

    await client.query('BEGIN');

    const sender = await client.query(
      `SELECT *
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [req.user.id]
    );

    const receiver = await client.query(
      `SELECT *
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [recipientId]
    );

    if (!sender.rows.length || !receiver.rows.length) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'User not found'
      });
    }

    if (Number(sender.rows[0].balance) < value) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        error: 'Insufficient balance'
      });
    }

    await client.query(
      `UPDATE users
       SET balance = balance - $1
       WHERE id = $2`,
      [value, req.user.id]
    );

    await client.query(
      `UPDATE users
       SET balance = balance + $1
       WHERE id = $2`,
      [value, recipientId]
    );

    await client.query(
      `INSERT INTO txs
       (user_id,type,amount,status,description,counterparty)
       VALUES
       ($1,'transfer_out',$2,'completed','Transfer sent',$3)`,
      [
        req.user.id,
        value,
        receiver.rows[0].name
      ]
    );

    await client.query(
      `INSERT INTO txs
       (user_id,type,amount,status,description,counterparty)
       VALUES
       ($1,'transfer_in',$2,'completed','Transfer received',$3)`,
      [
        recipientId,
        value,
        sender.rows[0].name
      ]
    );

    await client.query('COMMIT');

    res.json({
      success: true
    });

  } catch (e) {
    await client.query('ROLLBACK');

    console.error(e);

    res.status(500).json({
      error: 'Transfer failed'
    });

  } finally {
    client.release();
  }
});


// ======================================================
// ADMIN USERS
// ======================================================

app.get('/api/admin/users', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Admin only'
      });
    }

    const r = await pool.query(
      `SELECT
        id,
        name,
        email,
        phone,
        role,
        balance,
        status,
        created_at
       FROM users
       ORDER BY created_at DESC`
    );

    res.json({
      users: r.rows
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Could not load users'
    });
  }
});


// ======================================================
// FREEZE USER
// ======================================================

app.post('/api/admin/users/:id/freeze', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Admin only'
      });
    }

    await pool.query(
      `UPDATE users
       SET status = 'frozen'
       WHERE id = $1`,
      [req.params.id]
    );

    res.json({
      success: true
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Could not freeze user'
    });
  }
});


// ======================================================
// UNFREEZE USER
// ======================================================

app.post('/api/admin/users/:id/unfreeze', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Admin only'
      });
    }

    await pool.query(
      `UPDATE users
       SET status = 'active'
       WHERE id = $1`,
      [req.params.id]
    );

    res.json({
      success: true
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Could not activate user'
    });
  }
});


// ======================================================
// LIVE PAYOUTS
// ======================================================
//
// RULE:
// 1. Only payouts created after activation are shown.
// 2. Each payout stays visible for 48 HOURS.
// 3. After 48 hours it disappears automatically.
// 4. Server restarts do not reset activation time.
// ======================================================

app.get('/api/public/activity', auth, async (req, res) => {
  try {

    const r = await pool.query(`
      SELECT
        t.amount,
        t.created_at,
        t.type,
        u.name
      FROM txs t
      JOIN users u
        ON u.id = t.user_id
      CROSS JOIN (
        SELECT value::timestamptz AS start_time
        FROM app_settings
        WHERE key = 'live_payouts_start'
      ) settings
      WHERE t.type IN ('withdrawal', 'admin_payout')
        AND t.status = 'completed'

        -- Do not show payouts created before activation
        AND t.created_at >= settings.start_time

        -- Remove each payout after 48 hours
        AND t.created_at >= NOW() - INTERVAL '48 hours'

        AND t.amount > 0

      ORDER BY t.created_at DESC
    `);

    const items = r.rows.map(row => {

      const customerName =
        String(row.name || 'Customer')
          .trim()
          .split(/\s+/)[0];

      const amount = Number(row.amount);

      const formattedAmount =
        amount.toLocaleString('en-KE');

      const message =
        `${customerName} have received KES ${formattedAmount} from Biashara Loans`;

      return {
        name: customerName,
        amount: amount,
        sender: 'Biashara Loans',
        type: row.type,
        message: message,
        at: row.created_at
      };
    });

    res.json({
      items
    });

  } catch (e) {

    console.error(e);

    res.status(500).json({
      error: 'Could not load live payouts'
    });
  }
});


// ======================================================
// HEALTH CHECK
// ======================================================

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'KES Wallet API'
  });
});


// ======================================================
// START SERVER
// ======================================================

init()
  .then(() => {

    app.listen(PORT, () => {
      console.log(
        `Server running on port ${PORT}`
      );
    });

  })
  .catch(err => {

    console.error(
      'Database initialization failed:',
      err
    );

    process.exit(1);
  });