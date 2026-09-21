/**
 * PowerDial Backend Server
 * Triple-line dialer powered by Twilio
 *
 * Requires: Node.js 18+, Twilio account
 * Run: node server.js
 */

const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Twilio Client ────────────────────────────────────────────────────────────
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const TWILIO_PHONE    = process.env.TWILIO_PHONE_NUMBER;   // Your Twilio caller ID
const AGENT_PHONE     = process.env.AGENT_PHONE_NUMBER;    // Jose's real phone number
const BASE_URL        = process.env.PUBLIC_URL;             // ngrok or Railway URL
const CONFERENCE_NAME = 'PowerDial-Session';

// ─── In-Memory State ──────────────────────────────────────────────────────────
let sessionState = {
  active: false,
  lines: [
    { lineId: 1, callSid: null, status: 'idle', contact: null },
    { lineId: 2, callSid: null, status: 'idle', contact: null },
    { lineId: 3, callSid: null, status: 'idle', contact: null },
  ],
  agentCallSid: null,    // The call connecting agent to conference
  connectedLine: null,   // Which lineId is connected to agent
  conference: null,
  callLog: []
};

// ─── Helper: Update a Line ────────────────────────────────────────────────────
function setLine(lineId, updates) {
  const line = sessionState.lines.find(l => l.lineId === lineId);
  if (line) Object.assign(line, updates);
}

function getLine(lineId) {
  return sessionState.lines.find(l => l.lineId === lineId);
}

// ─── Route: Start Dial Session ────────────────────────────────────────────────
// POST /api/session/start
// Body: { contacts: [{name, phone}], callerId, agentPhone, vmUrl }
app.post('/api/session/start', async (req, res) => {
  const { contacts, callerId, agentPhone, vmUrl } = req.body;

  if (!contacts || !contacts.length) {
    return res.status(400).json({ error: 'No contacts provided' });
  }

  sessionState.active = true;
  const calls = [];

  try {
    // Dial each contact and put them in the conference (waiting with music)
    for (let i = 0; i < Math.min(contacts.length, 3); i++) {
      const contact = contacts[i];
      const lineId = i + 1;

      const call = await client.calls.create({
        to: contact.phone,
        from: callerId || TWILIO_PHONE,
        url: `${BASE_URL}/twiml/outbound?lineId=${lineId}&name=${encodeURIComponent(contact.name)}`,
        statusCallback: `${BASE_URL}/webhook/call-status?lineId=${lineId}`,
        statusCallbackEvent: ['answered', 'completed', 'no-answer', 'busy', 'failed'],
        statusCallbackMethod: 'POST',
        // AMD intentionally disabled — causes 3-7s silence on answer, leads hang up.
        // Handle voicemails manually: click "Left VM" → system drops pre-recorded message.
      });

      setLine(lineId, {
        callSid: call.sid,
        status: 'ringing',
        contact: contact
      });

      calls.push({ lineId, sid: call.sid, contact });
    }

    // Also call the agent's phone and drop them into the same conference (on hold until needed)
    const agentCall = await client.calls.create({
      to: agentPhone || AGENT_PHONE,
      from: TWILIO_PHONE,
      url: `${BASE_URL}/twiml/agent`,
      statusCallback: `${BASE_URL}/webhook/agent-status`,
      statusCallbackEvent: ['answered', 'completed'],
      statusCallbackMethod: 'POST'
    });
    sessionState.agentCallSid = agentCall.sid;

    res.json({ success: true, calls });

  } catch (err) {
    console.error('Dial error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: Session Status Poll ───────────────────────────────────────────────
// GET /api/session/status  (frontend polls this every second)
app.get('/api/session/status', (req, res) => {
  res.json({
    active: sessionState.active,
    lines: sessionState.lines.map(l => ({
      lineId: l.lineId,
      status: l.status,
      contact: l.contact
    })),
    connectedLine: sessionState.connectedLine
  });
});

// ─── Route: Hang Up a Line ────────────────────────────────────────────────────
app.post('/api/lines/:lineId/hangup', async (req, res) => {
  const lineId = parseInt(req.params.lineId);
  const line = getLine(lineId);
  if (!line || !line.callSid) return res.json({ success: false });

  try {
    await client.calls(line.callSid).update({ status: 'completed' });
    setLine(lineId, { status: 'idle', callSid: null, contact: null });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: Mute a Line ───────────────────────────────────────────────────────
app.post('/api/lines/:lineId/mute', async (req, res) => {
  const lineId = parseInt(req.params.lineId);
  const line = getLine(lineId);
  const { muted } = req.body;

  try {
    // Mute via conference participant API
    const confs = await client.conferences.list({ friendlyName: CONFERENCE_NAME, status: 'in-progress', limit: 1 });
    if (confs.length) {
      const participants = await client.conferences(confs[0].sid).participants.list();
      const p = participants.find(pt => pt.callSid === line.callSid);
      if (p) await client.conferences(confs[0].sid).participants(line.callSid).update({ muted });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: Hold ──────────────────────────────────────────────────────────────
app.post('/api/calls/hold', async (req, res) => {
  const { hold } = req.body;
  try {
    const confs = await client.conferences.list({ friendlyName: CONFERENCE_NAME, status: 'in-progress', limit: 1 });
    if (confs.length) {
      await client.conferences(confs[0].sid).participants(sessionState.agentCallSid)
        .update({ hold });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: Manual Voicemail Drop ────────────────────────────────────────────
// Called when agent clicks "Left VM" on an active or just-ended call.
// Redirects the lead's call to play the pre-recorded VM, then hangs up.
app.post('/api/lines/:lineId/drop-voicemail', async (req, res) => {
  const lineId = parseInt(req.params.lineId);
  const line = getLine(lineId);
  const vmUrl = process.env.VOICEMAIL_URL || '';

  if (!line?.callSid) return res.json({ success: false, error: 'No active call on this line' });

  try {
    await client.calls(line.callSid).update({
      twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${vmUrl
    ? `<Play>${vmUrl}</Play>`
    : `<Say voice="Polly.Joanna">Hi, this is Jose Cruz with Douglas Elliman. I was calling about homes in the Hudson Valley area — places like Beacon and Poughkeepsie where you can get a three to four bedroom home for under five hundred thousand. Give me a call back when you get a chance. Thanks so much.</Say>`
  }
  <Hangup/>
</Response>`
    });
    setLine(lineId, { status: 'idle', callSid: null, contact: null });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: End Session ───────────────────────────────────────────────────────
app.post('/api/session/end', async (req, res) => {
  sessionState.active = false;
  const toHangup = sessionState.lines.filter(l => l.callSid).map(l => l.callSid);
  if (sessionState.agentCallSid) toHangup.push(sessionState.agentCallSid);

  await Promise.allSettled(
    toHangup.map(sid => client.calls(sid).update({ status: 'completed' }).catch(()=>{}))
  );

  sessionState.lines.forEach(l => Object.assign(l, { callSid: null, status: 'idle', contact: null }));
  sessionState.agentCallSid = null;
  sessionState.connectedLine = null;

  res.json({ success: true });
});

// ─── TwiML: Outbound lead call ────────────────────────────────────────────────
// Called by Twilio when it connects to a lead's phone
app.all('/twiml/outbound', (req, res) => {
  const lineId = req.query.lineId || req.body.lineId;

  res.set('Content-Type', 'text/xml');
  // No Pause, no hold music fetch — lead enters conference immediately on answer.
  // startConferenceOnEnter=false keeps them waiting silently until agent bridges in.
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Conference
    startConferenceOnEnter="false"
    endConferenceOnExit="false"
    beep="false"
    waitUrl=""
    record="record-from-start"
    recordingStatusCallback="${BASE_URL}/webhook/recording"
    maxParticipants="4">
    ${CONFERENCE_NAME}-Line${lineId}
  </Conference>
</Response>`);
});

// ─── TwiML: Agent phone ───────────────────────────────────────────────────────
// Called when Twilio dials Jose's phone
app.all('/twiml/agent', (req, res) => {
  res.set('Content-Type', 'text/xml');
  // Agent starts on hold — when a lead connects, we bridge them
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">PowerDial connected. You will be bridged when a lead answers.</Say>
  <Conference
    waitUrl="https://twimlets.com/holdmusic?Bucket=com.twilio.music.softrock"
    waitMethod="GET"
    beep="false"
    startConferenceOnEnter="false"
    endConferenceOnExit="true"
    maxParticipants="4">
    ${CONFERENCE_NAME}-Agent
  </Conference>
</Response>`);
});

// ─── TwiML: Voicemail Drop ────────────────────────────────────────────────────
app.all('/twiml/voicemail', (req, res) => {
  const vmUrl = decodeURIComponent(req.query.vmUrl || '');
  res.set('Content-Type', 'text/xml');
  if (vmUrl) {
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${vmUrl}</Play>
  <Hangup/>
</Response>`);
  } else {
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Hi, this is Jose Cruz with Douglas Elliman Real Estate. I was calling about homes in the Hudson Valley area. Please give me a call back at your convenience. Thank you!</Say>
  <Hangup/>
</Response>`);
  }
});

// ─── Webhook: Call Status Updates ────────────────────────────────────────────
// Twilio calls this when a lead's call status changes
app.post('/webhook/call-status', async (req, res) => {
  const lineId = parseInt(req.query.lineId);
  const { CallStatus, CallSid } = req.body;

  console.log(`[Line ${lineId}] Status: ${CallStatus}`);

  const statusMap = {
    'in-progress': 'connected',
    'completed': 'idle',
    'no-answer': 'noanswer',
    'busy': 'busy',
    'failed': 'noanswer',
    'canceled': 'idle'
  };

  const newStatus = statusMap[CallStatus] || CallStatus;

  if (CallStatus === 'in-progress') {
    // Lead answered! Bridge agent to this conference
    if (!sessionState.connectedLine) {
      sessionState.connectedLine = lineId;
      setLine(lineId, { status: 'connected' });

      // Move agent from Agent conference to the lead's conference
      try {
        await bridgeAgentToLine(lineId);
        // Drop other ringing lines
        sessionState.lines.forEach(l => {
          if (l.lineId !== lineId && l.status === 'ringing' && l.callSid) {
            client.calls(l.callSid).update({ status: 'completed' }).catch(()=>{});
            setLine(l.lineId, { status: 'idle', callSid: null });
          }
        });
      } catch (e) {
        console.error('Bridge error:', e);
      }
    } else {
      // Agent already on another call — put this lead on hold music, then hang up
      client.calls(CallSid).update({
        twiml: `<Response><Say>Thank you for answering. Our agent will call you back shortly.</Say><Hangup/></Response>`
      }).catch(()=>{});
      setLine(lineId, { status: 'idle', callSid: null });
    }
  } else if (['completed', 'no-answer', 'busy', 'failed', 'canceled'].includes(CallStatus)) {
    if (lineId === sessionState.connectedLine && CallStatus === 'completed') {
      sessionState.connectedLine = null;
      // Call ended — frontend will show disposition
    }
    setLine(lineId, { status: newStatus, callSid: null });
  }

  res.set('Content-Type', 'text/xml');
  res.send('<Response/>');
});

// AMD webhook removed — AMD disabled for zero connection delay.
// Voicemail drops are triggered manually via the "Left VM" button in the UI.

// ─── Webhook: Recording ───────────────────────────────────────────────────────
app.post('/webhook/recording', (req, res) => {
  const { RecordingUrl, RecordingDuration, CallSid } = req.body;
  console.log(`[Recording] ${RecordingUrl} (${RecordingDuration}s) for call ${CallSid}`);
  sessionState.callLog.push({ recordingUrl: RecordingUrl, duration: RecordingDuration, callSid: CallSid, timestamp: new Date() });
  res.set('Content-Type', 'text/xml');
  res.send('<Response/>');
});

// ─── Webhook: Agent Status ────────────────────────────────────────────────────
app.post('/webhook/agent-status', (req, res) => {
  const { CallStatus } = req.body;
  console.log(`[Agent] Status: ${CallStatus}`);
  if (CallStatus === 'completed') sessionState.agentCallSid = null;
  res.set('Content-Type', 'text/xml');
  res.send('<Response/>');
});

// ─── Helper: Bridge agent call to a specific line's conference ─────────────────
async function bridgeAgentToLine(lineId) {
  // Transfer the agent's call to the line's conference
  await client.calls(sessionState.agentCallSid).update({
    twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Conference beep="false" record="record-from-start" recordingStatusCallback="${BASE_URL}/webhook/recording" maxParticipants="4">
    ${CONFERENCE_NAME}-Line${lineId}
  </Conference>
</Response>`
  });
}

// ─── Route: Recordings list ───────────────────────────────────────────────────
app.get('/api/recordings', async (req, res) => {
  try {
    const recordings = await client.recordings.list({ limit: 50 });
    res.json(recordings.map(r => ({
      sid: r.sid,
      url: `https://api.twilio.com${r.uri.replace('.json', '.mp3')}`,
      duration: r.duration,
      date: r.dateCreated
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Test: Run Skip Trace from Railway ───────────────────────────────────────
// POST /api/expireds/test-run
// Body: { listings: [{address, city, state, zip, county, listPrice, beds, baths}], apiKey }
// Skip traces the provided addresses using DATASKIP_API_KEY already on Railway
app.post('/api/expireds/test-run', async (req, res) => {
  const { listings, apiKey } = req.body;
  const expectedKey = process.env.EXPIREDS_API_KEY;
  if (expectedKey && apiKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!Array.isArray(listings) || !listings.length) {
    return res.status(400).json({ error: 'No listings provided' });
  }

  const DATASKIP_KEY = process.env.DATASKIP_API_KEY;
  if (!DATASKIP_KEY) return res.status(500).json({ error: 'DATASKIP_API_KEY not set on server' });

  console.log(`[Expireds] Test run: skip tracing ${listings.length} listings...`);
  const contacts = [];
  let hits = 0, misses = 0;

  for (const listing of listings) {
    try {
      const skipRes = await fetch('https://app.dataskip.io/api/v1/skip-trace', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${DATASKIP_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: listing.address, city: listing.city, state: listing.state || 'NY', zip: listing.zip })
      });
      const data = await skipRes.json();

      if (!data.found || !data.phones?.length) { misses++; continue; }

      const cleanPhones = data.phones
        .filter(p => !p.dnc)
        .map(p => ({ phone: p.number, label: p.type === 'mobile' ? 'Cell' : 'Home', status: 'pending' }));

      if (!cleanPhones.length) { misses++; continue; }

      hits++;
      contacts.push({
        name:      data.fullName || 'Property Owner',
        phones:    cleanPhones,
        address:   listing.address,
        city:      listing.city,
        state:     listing.state || 'NY',
        zip:       listing.zip,
        county:    listing.county || '',
        listPrice: listing.listPrice || '',
        beds:      listing.beds || '',
        baths:     listing.baths || '',
        status:    'pending'
      });

      await new Promise(r => setTimeout(r, 200));
    } catch(err) {
      console.error(`[Expireds] Skip trace error for ${listing.address}:`, err.message);
      misses++;
    }
  }

  // Push to queue so PowerDial picks them up
  await dbAddContacts(contacts);
  const queueSize = await dbCount();
  console.log(`[Expireds] Test run complete: ${hits} hits, ${misses} misses. Queue: ${queueSize}`);
  res.json({ success: true, hits, misses, queued: contacts.length });
});

// ─── Expireds Queue (PostgreSQL) ─────────────────────────────────────────────
// Contacts survive Railway restarts via PostgreSQL
const pgPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!pgPool) { console.log('[Expireds] No DATABASE_URL — using in-memory queue'); return; }
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS expireds_queue (
        id SERIAL PRIMARY KEY,
        contact JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('[Expireds] PostgreSQL queue table ready');
  } catch(e) {
    console.error('[Expireds] DB init error:', e.message);
  }
}
initDb();
console.log("[Expireds] DATABASE_URL set:", !!process.env.DATABASE_URL);
console.log("[Expireds] pgPool ready:", !!pgPool);

// In-memory fallback if no DB
let memQueue = [];

async function dbAddContacts(contacts) {
  if (!pgPool) { memQueue = [...memQueue, ...contacts]; return; }
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    for (const c of contacts) {
      await client.query('INSERT INTO expireds_queue (contact) VALUES ($1)', [JSON.stringify(c)]);
    }
    await client.query('COMMIT');
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function dbGetContacts() {
  if (!pgPool) return memQueue;
  const res = await pgPool.query('SELECT contact FROM expireds_queue ORDER BY id');
  return res.rows.map(r => r.contact);
}

async function dbClearContacts() {
  if (!pgPool) { memQueue = []; return; }
  await pgPool.query('DELETE FROM expireds_queue');
}

async function dbCount() {
  if (!pgPool) return memQueue.length;
  const res = await pgPool.query('SELECT COUNT(*) FROM expireds_queue');
  return parseInt(res.rows[0].count, 10);
}

// POST /api/expireds/queue
// Called by the automation script each morning after skip tracing
// Body: { contacts: [{name, phones, notes, city, county, listPrice, beds, baths, address}], apiKey }
app.post('/api/expireds/queue', (req, res) => {
  const { contacts, apiKey } = req.body;
  const expectedKey = process.env.EXPIREDS_API_KEY;
  if (expectedKey && apiKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!Array.isArray(contacts) || !contacts.length) {
    return res.status(400).json({ error: 'No contacts provided' });
  }
  try {
    await dbAddContacts(contacts);
    const total = await dbCount();
    console.log(`[Expireds] Queued ${contacts.length} contacts. Total pending: ${total}`);
    res.json({ success: true, queued: contacts.length, total });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/expireds/today
// Returns queued contacts WITHOUT clearing — safe to call multiple times
app.get('/api/expireds/today', async (req, res) => {
  try {
    const contacts = await dbGetContacts();
    res.json({ contacts, count: contacts.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/expireds/pending
// Called by PowerDial on startup — returns all queued contacts and clears the queue
app.get('/api/expireds/pending', async (req, res) => {
  try {
    const contacts = await dbGetContacts();
    // Don't clear — use /api/expireds/today for non-destructive reads
    console.log(`[Expireds] Delivered ${contacts.length} pending contacts`);
    res.json({ contacts, count: contacts.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/expireds/status
// Check queue without clearing it
app.get('/api/expireds/status', async (req, res) => {
  try {
    const count = await dbCount();
    res.json({ pending: count });
  } catch(e) {
    res.json({ pending: 0 });
  }
});

// ─── Debug Endpoint ─────────────────────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
  const dbOk = pgPool ? await pgPool.query('SELECT 1').then(()=>true).catch(()=>false) : false;
  const count = pgPool ? await pgPool.query('SELECT COUNT(*) FROM expireds_queue').then(r=>parseInt(r.rows[0].count,10)).catch(()=>-1) : memQueue.length;
  res.json({ databaseUrl: !!process.env.DATABASE_URL, pgPoolReady: !!pgPool, dbConnected: dbOk, queueCount: count, memQueueLen: memQueue.length });
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    demoMode: false,
    twilioConfigured: !!process.env.TWILIO_ACCOUNT_SID,
    expiredsPending: await dbCount().catch(() => 0)
  });
});

// ─── Serve Frontend ───────────────────────────────────────────────────────────
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 PowerDial server running on port ${PORT}`);
  console.log(`   Frontend: http://localhost:${PORT}`);
  console.log(`   Health:   http://localhost:${PORT}/health`);
  console.log(`   Mode:     ${process.env.TWILIO_ACCOUNT_SID ? '✅ Live (Twilio connected)' : '⚠️  No Twilio credentials'}`);
  if (!process.env.PUBLIC_URL) console.log(`   ⚠️  PUBLIC_URL not set — run ngrok and set it in .env`);
});
