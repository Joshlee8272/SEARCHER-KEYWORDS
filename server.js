// Save as server.js (ESM)
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '200mb' }));

// file upload
const upload = multer({ dest: path.join(os.tmpdir(), 'tg_uploads') });

// In-memory state (for demo). For production persist sessions & phone_code_hashes properly.
let client = null;
let sessionString = '';
let storedApiId = null;
let storedApiHash = null;
const phoneState = {}; // phone -> phone_code_hash
let qrWaiter = null;   // { promise, resolve, reject } for QR login flow

// Helper to create Telegram client instance
async function createClient(apiId, apiHash, existingSession='') {
  const stringSession = new StringSession(existingSession || '');
  const tg = new TelegramClient(stringSession, Number(apiId), apiHash, {
    connectionRetries: 5
  });
  await tg.connect();
  return tg;
}

/* -----------------------
   /auth/start   (POST)
   body: { apiId, apiHash }
   Initializes server-side Telegram client (not logged in yet)
   ----------------------- */
app.post('/auth/start', async (req, res) => {
  try {
    const { apiId, apiHash } = req.body;
    if (!apiId || !apiHash) return res.status(400).json({ error: 'apiId & apiHash required' });
    storedApiId = Number(apiId);
    storedApiHash = apiHash;
    // Create client but not signed in yet
    client = await createClient(apiId, apiHash, sessionString);
    return res.json({ ok: true });
  } catch (err) {
    console.error('auth/start error', err);
    return res.status(500).json({ error: err.toString() });
  }
});

/* -----------------------
   /auth/sendCode  (POST)
   body: { phone }
   Sends SMS code and stores phone_code_hash
   ----------------------- */
app.post('/auth/sendCode', async (req, res) => {
  try {
    if (!client) return res.status(400).json({ error: 'client not initialized (call /auth/start)' });
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });

    // sendCodeRequest is the underlying low-level. gramjs exposes a helper:
    // call client.sendCodeRequest(phone) or client.sendCode? library version differences exist.
    // We'll attempt sendCodeRequest, otherwise fallback to invoking via client.sendCodeRequest
    let result;
    if (typeof client.sendCodeRequest === 'function') {
      result = await client.sendCodeRequest(phone);
    } else {
      // if method name differs, try 'sendCode'
      result = await client.sendCode(phone);
    }
    // result may contain phoneCodeHash or phone_code_hash (depends on version)
    const phone_code_hash = result.phoneCodeHash || result.phone_code_hash || (result._ ? result._ : null);
    phoneState[phone] = phone_code_hash;
    console.log('sent code to', phone, 'hash=', phone_code_hash);
    return res.json({ ok: true });
  } catch (err) {
    console.error('/auth/sendCode error', err);
    return res.status(500).json({ error: err.toString() });
  }
});

/* -----------------------
   /auth/verify (POST)
   body: { phone, code }
   Completes sign-in and saves session string
   ----------------------- */
app.post('/auth/verify', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!client) return res.status(400).json({ error: 'client not initialized' });
    if (!phone || !code) return res.status(400).json({ error: 'phone & code required' });
    const phone_code_hash = phoneState[phone];
    if (!phone_code_hash) return res.status(400).json({ error: 'no phone_code_hash for this phone. Call /auth/sendCode first' });

    // signIn may be called as client.signIn({phoneNumber, phoneCode, phoneCodeHash})
    // Some versions accept client.signIn(phone, code)
    let signResult;
    if (typeof client.signIn === 'function') {
      // attempt object style
      try {
        signResult = await client.signIn({ phoneNumber: phone, phoneCode: code, phoneCodeHash: phone_code_hash });
      } catch (e) {
        // fallback to two-step: signIn with phone+hash may return error "SESSION_PASSWORD_NEEDED"
        // Try alternative signature:
        signResult = await client.signIn(phone, code);
      }
    } else {
      signResult = await client.signIn(phone, code);
    }

    // Save session to string
    sessionString = client.session.save();
    console.log('Logged in. Session saved.');
    return res.json({ ok: true, session: sessionString });
  } catch (err) {
    console.error('/auth/verify error', err);
    return res.status(500).json({ error: err.toString() });
  }
});

/* -----------------------
   /auth/qr/start  (POST)
   body: { apiId, apiHash }
   Start QR login and return dataUrl PNG to show on frontend.
   NOTE: QR flows differ by lib version. This implementation uses a fallback: create a login token and generate QR externally.
   ----------------------- */
app.post('/auth/qr/start', async (req, res) => {
  try {
    const { apiId, apiHash } = req.body;
    if (!apiId || !apiHash) return res.status(400).json({ error: 'apiId & apiHash required' });

    // For simplicity we will create a new client instance and try to call qrLogin if available
    const tmpClient = await createClient(apiId, apiHash, '');
    if (!tmpClient || typeof tmpClient.qrLogin !== 'function') {
      await tmpClient.disconnect?.();
      return res.status(501).json({ error: 'QR login not supported by library version on server' });
    }

    // try to get qr token and produce data URL
    const qr = await tmpClient.qrLogin(); // returns an object with token and wait()
    // if qr.token is Buffer or Uint8Array — convert to base64 and produce data URL PNG (client may expect base64 PNG)
    // but gramjs's qrLogin may return a token that must be converted to a QR code image using a library.
    // We'll generate a simple text-based data result the frontend can display as text if necessary.
    const tokenText = qr.token.toString('base64');
    // Option A: produce a QR PNG (requires qrcode lib). But we avoided extra lib; frontend can show token text for scanning apps supporting data URI.
    // Instead, return token text and instruct frontend to generate a QR (frontend already expects data:image/png;base64...).
    // For convenience, attempt to return a data URI by making a simple SVG QR (but that requires QR generation on server).
    // To keep server minimal, return the token text and let frontend display it as plain text if needed.
    // Store qr.wait promise in global so /auth/qr/status can check it
    qrWaiter = qr;
    return res.json({ ok: true, qrData: 'data:text/plain;base64,' + tokenText });
  } catch (err) {
    console.error('/auth/qr/start error', err);
    return res.status(500).json({ error: err.toString() });
  }
});

app.get('/auth/qr/status', async (req, res) => {
  try {
    if (!qrWaiter) return res.json({ loggedIn: false });
    // qrWaiter.wait() resolves when scanned (may require awaiting). We won't block — we can check .isLogged or attempt to await with timeout.
    // This is a simplified check — library differences mean you may need to implement a more robust polling.
    try {
      await Promise.race([qrWaiter.wait(), new Promise((_, rej)=>setTimeout(()=>rej('pending'), 1000))]);
      // if reached here, likely logged in
      // update client & sessionString
      if (!client) client = await createClient(storedApiId, storedApiHash, '');
      sessionString = client.session.save();
      return res.json({ loggedIn: true });
    } catch (e) {
      return res.json({ loggedIn: false });
    }
  } catch (err) {
    console.error('/auth/qr/status error', err);
    return res.status(500).json({ error: err.toString() });
  }
});

app.post('/auth/qr/cancel', (req, res) => {
  qrWaiter = null;
  return res.json({ ok: true });
});

/* -----------------------
   /channels  (GET)
   Returns channels after login
   ----------------------- */
app.get('/channels', async (req, res) => {
  try {
    if (!client) return res.status(400).json({ error: 'not logged in' });
    // get dialogs
    const dialogs = await client.getDialogs({});
    const channels = dialogs
      .filter(d => d.isChannel)
      .map(d => ({ id: d.id.toString(), title: d.title }));
    return res.json(channels);
  } catch (err) {
    console.error('/channels error', err);
    return res.status(500).json({ error: err.toString() });
  }
});

/* -----------------------
   /send  (POST)
   multipart/form-data: fields: channelId, files[] (each file)
   ----------------------- */
app.post('/send', upload.array('files'), async (req, res) => {
  try {
    if (!client) return res.status(400).json({ error: 'not logged in' });
    const channelId = req.body.channelId;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });
    // files are in req.files
    for (const f of req.files || []) {
      const filePath = path.resolve(f.path);
      // convert channelId to entity. GramJS accepts channel id or inputPeer? try direct id
      // Use client.sendFile(target, { file: filePath, caption })
      try {
        await client.sendFile(channelId, { file: filePath, caption: f.originalname });
      } catch (err) {
        // try sending as message with file stream
        await client.sendMessage(channelId, { file: filePath, caption: f.originalname });
      } finally {
        // cleanup
        try { fs.unlinkSync(filePath); } catch(e){}
      }
    }
    return res.json({ status: 'sent' });
  } catch (err) {
    console.error('/send error', err);
    return res.status(500).json({ error: err.toString() });
  }
});

/* -----------------------
   Start server
   ----------------------- */
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`MTProto helper server running at http://localhost:${PORT}`);
});