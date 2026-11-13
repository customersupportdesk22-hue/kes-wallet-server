// Live chat module: Socket.io + native MongoDB driver — text, photos, likes, deletes
// Install:  npm i socket.io      (uses your existing "mongodb" package)
const { Server } = require('socket.io');
const { ObjectId } = require('mongodb');

const clean = (s, n) => String(s || '').trim().slice(0, n);
const isId = (s) => typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s);
const MAX_IMG = 3 * 1024 * 1024;

// Accepts only real jpeg/png/webp data URLs (checks the file signature too)
function parseImage(s) {
  if (typeof s !== 'string' || s.length > MAX_IMG * 1.4) return null;
  const i = s.indexOf(',');
  const mt = /^data:(image\/(?:jpeg|png|webp));base64$/.exec(s.slice(0, i));
  if (!mt) return null;
  const buf = Buffer.from(s.slice(i + 1), 'base64');
  if (!buf.length || buf.length > MAX_IMG) return null;
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const webp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  return jpeg || png || webp ? { mime: mt[1], buf } : null;
}

const pub = (m) => ({
  _id: String(m._id), visitorId: m.visitorId, from: m.from,
  text: m.deleted ? '' : (m.text || ''),
  image: m.deleted || !m.imageId ? null : '/chat-image/' + m.imageId,
  liked: { customer: !!(m.liked && m.liked.customer), admin: !!(m.liked && m.liked.admin) },
  deleted: !!m.deleted, createdAt: m.createdAt
});

/**
 * setupChat(httpServer, { app, db, verifyAdmin, corsOrigins })
 *  - app: your Express app (serves photos at /chat-image/:id)
 *  - db: your connected MongoDB Db object (the same one the rest of server.js uses)
 *  - verifyAdmin(token) -> true/false (or Promise): your existing JWT check + role === 'admin'
 */
async function setupChat(httpServer, { app, db, verifyAdmin, corsOrigins = '*' }) {
  const Threads = db.collection('chat_threads');
  const Messages = db.collection('chat_messages');
  const Images = db.collection('chat_images');
  await Threads.createIndex({ visitorId: 1 }, { unique: true });
  await Messages.createIndex({ visitorId: 1, createdAt: 1 });

  const io = new Server(httpServer, { cors: { origin: corsOrigins }, maxHttpBufferSize: 5e6 });

  if (app) {
    app.get('/chat-image/:id', async (req, res) => {
      try {
        if (!isId(req.params.id)) return res.sendStatus(404);
        const img = await Images.findOne({ _id: new ObjectId(req.params.id) });
        if (!img) return res.sendStatus(404);
        const origin = req.headers.origin;
        const ok = corsOrigins === '*' || (Array.isArray(corsOrigins) ? corsOrigins.includes(origin) : corsOrigins === origin);
        if (ok) res.set('Access-Control-Allow-Origin', corsOrigins === '*' ? '*' : origin);
        res.set({ 'Content-Type': img.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable' });
        res.send(Buffer.from(img.data.read(0, img.data.length())));
      } catch (e) { res.sendStatus(500); }
    });
  }

  async function saveMessage({ visitorId, from, text, image }) {
    let imageId = null;
    if (image) {
      const p = parseImage(image); if (!p) return { error: 'Invalid or too large image' };
      imageId = String((await Images.insertOne({ visitorId, mime: p.mime, data: p.buf, createdAt: new Date() })).insertedId);
    }
    text = clean(text, 1500);
    if (!text && !imageId) return { error: 'Empty message' };
    const m = { visitorId, from, text, imageId, liked: { customer: false, admin: false }, deleted: false, hiddenForCustomer: false, createdAt: new Date() };
    m._id = (await Messages.insertOne(m)).insertedId;
    return { m, preview: text || '📷 Photo' };
  }

  io.on('connection', async (socket) => {
    const { token, visitorId } = socket.handshake.auth || {};
    const isAdmin = !!token && await Promise.resolve(verifyAdmin(token)).catch(() => false);
    if (!isAdmin && (!visitorId || String(visitorId).length < 16)) return socket.disconnect(true);
    const role = isAdmin ? 'admin' : 'customer';
    if (isAdmin) socket.join('admins'); else socket.join('v:' + visitorId);

    socket.on('threads', async (_, ack) => {
      if (!isAdmin) return;
      try { ack?.(await Threads.find().sort({ lastAt: -1 }).limit(100).toArray()); } catch (e) { ack?.([]); }
    });

    socket.on('history', async (arg, ack) => {
      try {
        let q;
        if (isAdmin) {
          const id = arg && arg.visitorId; if (!id) return ack?.([]);
          await Threads.updateOne({ visitorId: id }, { $set: { unreadAdmin: 0 } });
          q = { visitorId: id };
        } else q = { visitorId, hiddenForCustomer: { $ne: true } };
        const list = await Messages.find(q).sort({ createdAt: -1 }).limit(isAdmin ? 300 : 150).toArray();
        ack?.(list.reverse().map(pub));
      } catch (e) { ack?.([]); }
    });

    let last = 0;
    socket.on(isAdmin ? 'reply' : 'msg', async (d, ack) => {
      try {
        d = d || {};
        if (Date.now() - last < (d.image ? 1200 : 600)) return ack?.({ ok: false, error: 'Too fast' });
        last = Date.now();
        const vid = isAdmin ? d.visitorId : visitorId;
        if (!vid) return ack?.({ ok: false });
        const r = await saveMessage({ visitorId: vid, from: role, text: d.text, image: d.image });
        if (r.error) return ack?.({ ok: false, error: r.error });
        const set = { lastMessage: r.preview, lastAt: r.m.createdAt };
        if (!isAdmin) { if (d.name) set.name = clean(d.name, 60); if (d.phone) set.phone = clean(d.phone, 20); }
        const upd = isAdmin ? { $set: set } : { $set: set, $inc: { unreadAdmin: 1 } };
        await Threads.updateOne({ visitorId: vid }, upd, { upsert: !isAdmin });
        const out = pub(r.m);
        io.to('v:' + vid).emit('msg', out);
        io.to('admins').emit('msg', out);
        ack?.({ ok: true, id: out._id });
      } catch (e) { ack?.({ ok: false, error: 'Server error' }); }
    });

    socket.on('like', async ({ id } = {}, ack) => {
      try {
        if (!isId(id)) return ack?.({ ok: false });
        const m = await Messages.findOne({ _id: new ObjectId(id) });
        if (!m || m.deleted || (!isAdmin && m.visitorId !== visitorId)) return ack?.({ ok: false });
        const cur = !!(m.liked && m.liked[role]);
        await Messages.updateOne({ _id: m._id }, { $set: { ['liked.' + role]: !cur } });
        m.liked = { customer: false, admin: false, ...(m.liked || {}), [role]: !cur };
        const out = pub(m);
        io.to('v:' + m.visitorId).emit('msg:update', out);
        io.to('admins').emit('msg:update', out);
        ack?.({ ok: true });
      } catch (e) { ack?.({ ok: false }); }
    });

    socket.on('delete', async ({ id } = {}, ack) => {
      try {
        if (!isId(id)) return ack?.({ ok: false });
        const m = await Messages.findOne({ _id: new ObjectId(id) });
        if (!m || (!isAdmin && m.visitorId !== visitorId)) return ack?.({ ok: false });
        if (m.from === role) {           // delete your own message for everyone
          await Messages.updateOne({ _id: m._id }, { $set: { deleted: true } });
          if (m.imageId && isId(m.imageId)) await Images.deleteOne({ _id: new ObjectId(m.imageId) }).catch(() => {});
          m.deleted = true;
          const out = pub(m);
          io.to('v:' + m.visitorId).emit('msg:update', out);
          io.to('admins').emit('msg:update', out);
        } else if (!isAdmin) {           // customer removes an admin message from their own chat only
          await Messages.updateOne({ _id: m._id }, { $set: { hiddenForCustomer: true } });
          socket.emit('msg:remove', { _id: String(m._id) });
        } else return ack?.({ ok: false });
        ack?.({ ok: true });
      } catch (e) { ack?.({ ok: false }); }
    });
  });
  return io;
}
module.exports = { setupChat };

/* ---- Usage in your server.js (after your MongoDB connection is ready) ----
const http = require('http');
const { setupChat } = require('./chat-server');
const server = http.createServer(app);           // replace app.listen(...)
await setupChat(server, {
  app, db,                                       // db = your connected Db object
  corsOrigins: ['https://biasharaloans.co.ke'],  // customer site + admin page origins
  verifyAdmin: (token) => {
    const u = jwt.verify(token, process.env.JWT_SECRET); // same as your auth middleware
    return u.role === 'admin';
  }
});
server.listen(PORT);
---------------------------------------------------------------------- */
