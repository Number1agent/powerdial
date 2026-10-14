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

// ─── PostgreSQL (expireds persistence) ───────────────────────────────────────
const { Pool } = require('pg');
const pgPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

if (pgPool) {
  pgPool.query(`
    CREATE TABLE IF NOT EXISTS expired_contacts (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL,
      queued_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('[DB] expired_contacts table ready'))
    .catch(err => console.error('[DB] Table creation error:', err.message));

  pgPool.query(`
    CREATE TABLE IF NOT EXISTS call_records (
      id BIGSERIAL PRIMARY KEY,
      record_id TEXT UNIQUE,
      date TIMESTAMPTZ,
      session_id TEXT,
      contact_name TEXT,
      phone TEXT,
      phone_label TEXT,
      city TEXT,
      state TEXT,
      outcome TEXT,
      duration_secs INT,
      notes TEXT,
      group_name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('[DB] call_records table ready'))
    .catch(err => console.error('[DB] call_records table error:', err.message));

  pgPool.query(`
    CREATE TABLE IF NOT EXISTS session_reports (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT UNIQUE,
      date TIMESTAMPTZ,
      end_time TIMESTAMPTZ,
      duration_secs INT,
      calls INT,
      connected INT,
      vm INT,
      appts INT,
      callbacks INT,
      contact_rate INT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('[DB] session_reports table ready'))
    .catch(err => console.error('[DB] session_reports table error:', err.message));
} else {
  console.warn('[DB] No DATABASE_URL — expireds will be in-memory only');
}

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

// ─── Number Pool (rotation) ───────────────────────────────────────────────────
// Set TWILIO_PHONE_NUMBERS=+12125550001,+12125550002,+12125550003 in Railway
// Falls back to TWILIO_PHONE_NUMBER if not set
const NUMBER_POOL = (() => {
  const poolStr = process.env.TWILIO_PHONE_NUMBERS || '';
  const nums = poolStr.split(',').map(n => n.trim()).filter(n => n.startsWith('+'));
  if (nums.length) return nums;
  return TWILIO_PHONE ? [TWILIO_PHONE] : [];
})();
let _rotationIdx = 0;
function getNextNumber(contactPhone) {
  // Check if local presence rules apply (area code match)
  // Falls back to round-robin pool
  if (!NUMBER_POOL.length) return TWILIO_PHONE || '';
  const num = NUMBER_POOL[_rotationIdx % NUMBER_POOL.length];
  _rotationIdx++;
  return num;
}
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
  callLog: [],
  pendingContacts: [],   // Contacts to dial once agent answers
  pendingCallerId: null, // Caller ID to use for those calls
  conferenceRoom: null   // Unique conference room name per session
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

  // Unique room per session — prevents inheriting a stale Twilio conference from a previous Railway deployment
  const conferenceRoom = 'PowerDial-' + Date.now();

  sessionState.active = true;
  sessionState.pendingContacts = contacts.slice(0, 3);
  sessionState.pendingCallerId = callerId || null;
  sessionState.conferenceRoom = conferenceRoom;

  try {
    // Step 1: Call agent FIRST. Leads are dialed once agent answers (webhook/agent-status).
    // This prevents "Call is not in-progress" bridge errors when leads answer before agent.
    const agentCall = await client.calls.create({
      to: agentPhone || AGENT_PHONE,
      from: TWILIO_PHONE,
      url: `${BASE_URL}/twiml/agent?room=${encodeURIComponent(conferenceRoom)}`,
      statusCallback: `${BASE_URL}/webhook/agent-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });
    sessionState.agentCallSid = agentCall.sid;
    console.log('[Agent] Dialing agent, will dial leads once agent answers...');

    res.json({ success: true, calls: [] });

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
  const room = req.query.room || req.body.room || sessionState.conferenceRoom || CONFERENCE_NAME;

  res.set('Content-Type', 'text/xml');
  // Lead waits with hold music. When they answer, /webhook/call-status redirects their
  // call to startConferenceOnEnter=true, which bridges them to the waiting agent.
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Conference
    startConferenceOnEnter="false"
    endConferenceOnExit="false"
    waitUrl="${BASE_URL}/twiml/hold"
    waitMethod="GET"
    beep="false"
    maxParticipants="10">${room}</Conference>
</Response>`);
});


// ─── TwiML: Hold music (conference waitUrl) ───────────────────────────────────
app.all('/twiml/hold', (req, res) => {
  res.set('Content-Type', 'text/xml');
  // Twilio Conference waitUrl only supports <Play> and <Say> — <Pause> is silently
  // dropped and rapid re-fetches can terminate the waiting participant.
  // loop="0" repeats indefinitely until the conference starts (agent gets connected).
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" loop="0">Please hold. Your call will be connected shortly.</Say>
</Response>`);
});

// ─── TwiML: Agent phone ───────────────────────────────────────────────────────
// Called when Twilio dials Jose's phone
app.all('/twiml/agent', (req, res) => {
  const room = req.query.room || req.body.room || sessionState.conferenceRoom || CONFERENCE_NAME;
  res.set('Content-Type', 'text/xml');
  // Agent waits with hold music (startConferenceOnEnter=false).
  // Conference only truly starts when a live lead is redirected in with startConferenceOnEnter=true.
  // This prevents silence-based carrier drops and stale-conference bugs.
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">PowerDial connected. Leads are dialing now.</Say>
  <Conference
    beep="false"
    startConferenceOnEnter="false"
    endConferenceOnExit="true"
    waitUrl="${BASE_URL}/twiml/hold"
    waitMethod="GET"
    maxParticipants="10">${room}</Conference>
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
    // Lead answered!
    if (!sessionState.connectedLine) {
      sessionState.connectedLine = lineId;
      setLine(lineId, { status: 'connected' });

      const room = sessionState.conferenceRoom || CONFERENCE_NAME;

      // Redirect the LEAD (not the agent) to startConferenceOnEnter=true.
      // This starts the conference and connects the agent (who is waiting with hold music).
      // Redirecting the lead avoids the 21220 "call not in-progress" race condition.
      client.calls(CallSid).update({
        twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Conference startConferenceOnEnter="true" endConferenceOnExit="false" beep="false" maxParticipants="10">${room}</Conference></Response>`
      }).then(() => {
        console.log(`[Line ${lineId}] Lead bridged into ${room} — agent connected`);
      }).catch(e => {
        console.error(`[Line ${lineId}] Bridge error: ${e.message}`);
        setLine(lineId, { status: 'idle', callSid: null });
        sessionState.connectedLine = null;
      });

      // Cancel other ringing lines
      sessionState.lines.forEach(l => {
        if (l.lineId !== lineId && l.status === 'ringing' && l.callSid) {
          client.calls(l.callSid).update({ status: 'completed' }).catch(()=>{});
          setLine(l.lineId, { status: 'idle', callSid: null });
        }
      });
    } else {
      // Agent already connected — hang up this lead
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
app.post('/webhook/agent-status', async (req, res) => {
  const { CallStatus } = req.body;
  console.log(`[Agent] Status: ${CallStatus}`);

  if (CallStatus === 'in-progress') {
    // Agent answered — NOW dial the leads
    const contacts = sessionState.pendingContacts || [];
    const callerId = sessionState.pendingCallerId;
    sessionState.pendingContacts = [];
    sessionState.pendingCallerId = null;

    console.log(`[Agent] Ready — dialing ${contacts.length} lead(s)`);
    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      const lineId = i + 1;
      try {
        const call = await client.calls.create({
          to: contact.phone,
          from: callerId || getNextNumber(contact.phone) || TWILIO_PHONE,
          url: `${BASE_URL}/twiml/outbound?lineId=${lineId}&name=${encodeURIComponent(contact.name)}&room=${encodeURIComponent(sessionState.conferenceRoom || CONFERENCE_NAME)}`,
          statusCallback: `${BASE_URL}/webhook/call-status?lineId=${lineId}`,
          statusCallbackEvent: ['answered', 'completed', 'no-answer', 'busy', 'failed'],
          statusCallbackMethod: 'POST'
        });
        setLine(lineId, { callSid: call.sid, status: 'ringing', contact });
        console.log(`[Line ${lineId}] Dialing ${contact.name} (${contact.phone})`);
      } catch (e) {
        console.error(`[Line ${lineId}] Dial error:`, e.message);
      }
    }
  }

  if (CallStatus === 'completed') {
    sessionState.agentCallSid = null;
    sessionState.pendingContacts = [];
  }

  res.set('Content-Type', 'text/xml');
  res.send('<Response/>');
});

// ─── Helper: Bridge agent call to a specific line's conference ─────────────────
async function bridgeAgentToLine(lineId) {
  // Transfer the agent's call to the line's conference
  await client.calls(sessionState.agentCallSid).update({
    twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Conference
    beep="false"
    startConferenceOnEnter="true"
    endConferenceOnExit="false"
    maxParticipants="4">${CONFERENCE_NAME}-Line${lineId}</Conference>
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

  // Push to queue so PowerDial picks them up (use DB if available)
  if (pgPool) {
    try {
      await Promise.all(contacts.map(c => pgPool.query('INSERT INTO expired_contacts (data) VALUES ($1)', [JSON.stringify(c)])));
    } catch(dbErr) {
      console.error('[Expireds] Test DB insert error:', dbErr.message);
      expiredQueueFallback = [...expiredQueueFallback, ...contacts];
    }
  } else {
    expiredQueueFallback = [...expiredQueueFallback, ...contacts];
  }
  console.log(`[Expireds] Test run complete: ${hits} hits, ${misses} misses. Queued: ${contacts.length}`);
  res.json({ success: true, hits, misses, queued: contacts.length });
});

// ─── Expireds Queue (PostgreSQL-backed) ──────────────────────────────────────
// Contacts are persisted in DB — survive server restarts and browser wipes.
// Fallback to in-memory if DATABASE_URL is not set.
let expiredQueueFallback = [];

// POST /api/expireds/queue
// Called by fetch-expireds.js each morning after skip tracing
app.post('/api/expireds/queue', async (req, res) => {
  const { contacts, apiKey } = req.body;
  const expectedKey = process.env.EXPIREDS_API_KEY;
  if (expectedKey && apiKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!Array.isArray(contacts) || !contacts.length) {
    return res.status(400).json({ error: 'No contacts provided' });
  }
  if (pgPool) {
    try {
      // Insert each contact as a JSON row
      const inserts = contacts.map(c => pgPool.query(
        'INSERT INTO expired_contacts (data) VALUES ($1)', [JSON.stringify(c)]
      ));
      await Promise.all(inserts);
      const { rows } = await pgPool.query('SELECT COUNT(*) AS total FROM expired_contacts');
      const total = parseInt(rows[0].total, 10);
      console.log(`[Expireds] Queued ${contacts.length} contacts in DB. Total: ${total}`);
      return res.json({ success: true, queued: contacts.length, total });
    } catch (err) {
      console.error('[Expireds] DB insert error:', err.message);
      // fall through to in-memory
    }
  }
  // Fallback: in-memory
  expiredQueueFallback = [...expiredQueueFallback, ...contacts];
  console.log(`[Expireds] Queued ${contacts.length} contacts in memory. Total: ${expiredQueueFallback.length}`);
  res.json({ success: true, queued: contacts.length, total: expiredQueueFallback.length });
});

// GET /api/expireds/pending
// Called by PowerDial on startup — returns all contacts WITHOUT clearing them
// (they persist until /api/expireds/clear is called explicitly)
app.get('/api/expireds/pending', async (req, res) => {
  if (pgPool) {
    try {
      const { rows } = await pgPool.query('SELECT data FROM expired_contacts ORDER BY queued_at ASC');
      const contacts = rows.map(r => r.data);
      console.log(`[Expireds] Delivered ${contacts.length} persisted contacts to PowerDial`);
      return res.json({ contacts, count: contacts.length });
    } catch (err) {
      console.error('[Expireds] DB read error:', err.message);
    }
  }
  // Fallback: in-memory (do NOT clear)
  const contacts = [...expiredQueueFallback];
  console.log(`[Expireds] Delivered ${contacts.length} in-memory contacts to PowerDial`);
  res.json({ contacts, count: contacts.length });
});

// GET /api/expireds/status
// Check queue without affecting it
app.get('/api/expireds/status', async (req, res) => {
  if (pgPool) {
    try {
      const { rows } = await pgPool.query('SELECT COUNT(*) AS total FROM expired_contacts');
      return res.json({ pending: parseInt(rows[0].total, 10) });
    } catch (err) {
      console.error('[Expireds] DB status error:', err.message);
    }
  }
  res.json({ pending: expiredQueueFallback.length });
});

// DELETE /api/expireds/clear
// Explicitly clear all expireds (call when you're done dialing them)
app.delete('/api/expireds/clear', async (req, res) => {
  if (pgPool) {
    try {
      const { rowCount } = await pgPool.query('DELETE FROM expired_contacts');
      console.log(`[Expireds] Cleared ${rowCount} contacts from DB`);
      return res.json({ success: true, cleared: rowCount });
    } catch (err) {
      console.error('[Expireds] DB clear error:', err.message);
    }
  }
  const cleared = expiredQueueFallback.length;
  expiredQueueFallback = [];
  res.json({ success: true, cleared });
});


// ═══════════════════════════════════════════════════════════════════
// CLAUDE MCP ENDPOINTS — mirrors Mojo Dialer MCP integration
// Auth: Bearer token via POWERDIAL_CLAUDE_KEY env var
// ═══════════════════════════════════════════════════════════════════

function claudeAuth(req, res, next) {
  const key = process.env.POWERDIAL_CLAUDE_KEY;
  if (!key) return next(); // no key set = open (dev mode)
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${key}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function sinceDate(range) {
  const now = new Date();
  if (range === 'today') {
    const d = new Date(now); d.setHours(0,0,0,0); return d;
  } else if (range === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - 7); return d;
  } else if (range === 'month') {
    const d = new Date(now); d.setDate(d.getDate() - 30); return d;
  }
  return new Date(0); // all time
}

// POST /api/claude/sync/call — browser pushes each call record
app.post('/api/claude/sync/call', async (req, res) => {
  if (!pgPool) return res.json({ ok: false, reason: 'no_db' });
  const r = req.body;
  if (!r || !r.id) return res.status(400).json({ error: 'Missing record' });
  try {
    await pgPool.query(`
      INSERT INTO call_records
        (record_id, date, session_id, contact_name, phone, phone_label, city, state, outcome, duration_secs, notes, group_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (record_id) DO NOTHING
    `, [
      String(r.id), r.date ? new Date(r.date) : new Date(),
      r.sessionId, r.contactName, r.phone, r.phoneLabel,
      r.city, r.state, r.outcome, r.duration || 0, r.notes || '', r.groupName || ''
    ]);
    res.json({ ok: true });
  } catch(err) {
    console.error('[Claude sync call]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/claude/sync/session — browser pushes each session report
app.post('/api/claude/sync/session', async (req, res) => {
  if (!pgPool) return res.json({ ok: false, reason: 'no_db' });
  const s = req.body;
  if (!s || !s.id) return res.status(400).json({ error: 'Missing session' });
  try {
    await pgPool.query(`
      INSERT INTO session_reports
        (session_id, date, end_time, duration_secs, calls, connected, vm, appts, callbacks, contact_rate)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (session_id) DO NOTHING
    `, [
      String(s.id), s.date ? new Date(s.date) : new Date(),
      s.endTime ? new Date(s.endTime) : null,
      s.durationSecs || 0, s.calls || 0, s.connected || 0,
      s.vm || 0, s.appts || 0, s.callbacks || 0, s.contactRate || 0
    ]);
    res.json({ ok: true });
  } catch(err) {
    console.error('[Claude sync session]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/claude/account
app.get('/api/claude/account', claudeAuth, (req, res) => {
  res.json({
    agent: 'Jose Cruz',
    brokerage: 'Douglas Elliman',
    dialer: 'PowerDial',
    url: process.env.PUBLIC_URL || 'https://powerdial-production-85ab.up.railway.app',
    dbConnected: !!pgPool,
    timestamp: new Date().toISOString()
  });
});

// GET /api/claude/stats?range=today|week|month|all
app.get('/api/claude/stats', claudeAuth, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'No database connected' });
  const since = sinceDate(req.query.range || 'today');
  try {
    const { rows } = await pgPool.query(`
      SELECT
        COUNT(*) AS total_calls,
        SUM(CASE WHEN outcome NOT IN ('No Contact','No Answer','noanswer','Left VM','voicemail','Voicemail','Bad Number','DNC') THEN 1 ELSE 0 END) AS contacts,
        SUM(CASE WHEN outcome IN ('Left VM','voicemail','Voicemail') THEN 1 ELSE 0 END) AS voicemails,
        SUM(CASE WHEN outcome IN ('Appointment','Hot Lead','Interested') THEN 1 ELSE 0 END) AS appointments,
        SUM(CASE WHEN outcome = 'Callback' THEN 1 ELSE 0 END) AS callbacks,
        SUM(duration_secs) AS total_seconds,
        COUNT(DISTINCT session_id) AS session_count
      FROM call_records WHERE date >= $1
    `, [since]);
    const r = rows[0];
    const totalCalls = parseInt(r.total_calls) || 0;
    const contacts   = parseInt(r.contacts) || 0;
    const totalSecs  = parseInt(r.total_seconds) || 0;
    const hrs        = totalSecs / 3600;
    res.json({
      range: req.query.range || 'today',
      since: since.toISOString(),
      totalCalls,
      contacts,
      voicemails:   parseInt(r.voicemails) || 0,
      appointments: parseInt(r.appointments) || 0,
      callbacks:    parseInt(r.callbacks) || 0,
      contactRate:  totalCalls ? Math.round(contacts / totalCalls * 100) : 0,
      sessionCount: parseInt(r.session_count) || 0,
      totalDialTime: formatSecs(totalSecs),
      callsPerHour: hrs > 0 ? Math.round(totalCalls / hrs) : 0
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/claude/calls?range=today|week|month|all&limit=100
app.get('/api/claude/calls', claudeAuth, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'No database connected' });
  const since = sinceDate(req.query.range || 'today');
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  try {
    const { rows } = await pgPool.query(`
      SELECT record_id, date, contact_name, phone, phone_label, city, state,
             outcome, duration_secs, notes, group_name, session_id
      FROM call_records WHERE date >= $1
      ORDER BY date DESC LIMIT $2
    `, [since, limit]);
    res.json({
      range: req.query.range || 'today',
      count: rows.length,
      calls: rows.map(r => ({
        date: r.date,
        contact: r.contact_name,
        phone: r.phone,
        label: r.phone_label,
        city: r.city,
        state: r.state,
        outcome: r.outcome,
        duration: formatSecs(r.duration_secs),
        notes: r.notes,
        list: r.group_name,
        sessionId: r.session_id
      }))
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/claude/sessions?range=today|week|month|all
app.get('/api/claude/sessions', claudeAuth, async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: 'No database connected' });
  const since = sinceDate(req.query.range || 'week');
  try {
    const { rows } = await pgPool.query(`
      SELECT session_id, date, end_time, duration_secs, calls, connected, vm, appts, callbacks, contact_rate
      FROM session_reports WHERE date >= $1 ORDER BY date DESC
    `, [since]);
    res.json({
      range: req.query.range || 'week',
      count: rows.length,
      sessions: rows.map(s => ({
        date: s.date,
        endTime: s.end_time,
        duration: formatSecs(s.duration_secs),
        calls: s.calls,
        contacts: s.connected,
        voicemails: s.vm,
        appointments: s.appts,
        callbacks: s.callbacks,
        contactRate: s.contact_rate + '%'
      }))
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

function formatSecs(secs) {
  if (!secs) return '0:00';
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return m + ':' + String(s).padStart(2, '0');
}


// ─── Spam Check ───────────────────────────────────────────────────────────────
// POST /spam-check — checks numbers against Twilio Lookup + carrier reputation
app.post('/spam-check', async (req, res) => {
  const { numbers = [] } = req.body;
  if (!numbers.length) return res.json({ results: [] });
  if (!process.env.TWILIO_ACCOUNT_SID) {
    return res.json({ results: numbers.map(n => ({ number: n, flagged: false, note: 'Demo mode — Twilio not configured' })) });
  }
  try {
    const results = await Promise.all(numbers.map(async (number) => {
      try {
        const lookup = await client.lookups.v2.phoneNumbers(number)
          .fetch({ fields: 'line_type_intelligence' });
        // Twilio doesn't expose spam scores directly in free tier
        // Use line type as a signal: voip lines are more likely flagged
        const lt = lookup.lineTypeIntelligence;
        const lineType = lt ? lt.type : 'unknown';
        const flagged = false; // Twilio free lookup doesn't expose spam flag; real signal requires paid risk score
        return { number, flagged, lineType, note: lineType === 'voip' ? 'VoIP number — higher spam risk' : 'Mobile/landline — lower spam risk' };
      } catch(e) {
        return { number, flagged: false, note: 'Lookup failed: ' + e.message };
      }
    }));
    res.json({ results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Number Pool Info ─────────────────────────────────────────────────────────
// GET /api/numbers — returns pool and rotation index (for settings UI)
app.get('/api/numbers', (req, res) => {
  res.json({
    pool: NUMBER_POOL,
    rotationIdx: _rotationIdx,
    next: NUMBER_POOL.length ? NUMBER_POOL[_rotationIdx % NUMBER_POOL.length] : null
  });
});

// POST /api/numbers/reset — reset rotation counter
app.post('/api/numbers/reset', (req, res) => {
  _rotationIdx = 0;
  res.json({ ok: true, next: NUMBER_POOL.length ? NUMBER_POOL[0] : null });
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    demoMode: false,
    twilioConfigured: !!process.env.TWILIO_ACCOUNT_SID,
    expiredsPending: expiredQueueFallback.length
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
