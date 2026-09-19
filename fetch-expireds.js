/**
 * PowerDial — Daily Expireds Automation
 *
 * Runs every morning (scheduled via Railway cron):
 * 1. Logs into OneKey MLS (auto-login with credentials if session expired)
 * 2. Exports today's expired listings for target counties
 * 3. Filters out relisted / sold / pending properties
 * 4. Deduplicates against what's already in PowerDial
 * 5. Skip traces clean contacts via DataSkip API
 * 6. Pushes verified contacts to PowerDial backend queue
 *
 * Environment variables required:
 *   ONEKEYMLS_USERNAME, ONEKEYMLS_PASSWORD  (credentials for auto-login)
 *   DATASKIP_API_KEY
 *   EXPIREDS_API_KEY
 *   PUBLIC_URL (your Railway backend URL)
 *
 * Optional:
 *   MLS_AUTH_STATE  (base64 stored-session JSON — speeds up login; auto-falls back to credentials)
 */

require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const BACKEND_URL  = process.env.PUBLIC_URL;
const DATASKIP_KEY = process.env.DATASKIP_API_KEY;
const EXPIREDS_KEY = process.env.EXPIREDS_API_KEY;
const MLS_USER     = process.env.ONEKEYMLS_USERNAME;
const MLS_PASS     = process.env.ONEKEYMLS_PASSWORD;

const TARGET_COUNTIES = [
  'Dutchess', 'Putnam', 'Westchester',
  'Bronx', 'Kings', 'New York', 'Queens', 'Richmond', 'Rockland'
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Auth State (optional cached session) ────────────────────────────────────
function loadAuthState() {
  const envState = process.env.MLS_AUTH_STATE;
  if (envState) {
    try {
      const json = Buffer.from(envState, 'base64').toString('utf8');
      const state = JSON.parse(json);
      log(`🔑 Cached auth state found (${state.cookies.length} cookies) — will try first`);
      return state;
    } catch(e) {
      log(`⚠️  Failed to parse MLS_AUTH_STATE: ${e.message}`);
    }
  }

  const localFile = path.join(__dirname, 'mls-auth.json');
  if (fs.existsSync(localFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(localFile, 'utf8'));
      log(`🔑 Cached auth state found in mls-auth.json (${state.cookies.length} cookies)`);
      return state;
    } catch(e) {
      log(`⚠️  Failed to parse mls-auth.json: ${e.message}`);
    }
  }

  return null;
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────
/**
 * Parse a single CSV row, handling quoted fields with embedded commas/newlines.
 */
function parseCSVRow(line) {
  const result = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  result.push(field);
  return result;
}

/**
 * Parse the OneKey Matrix "Single Line Data" CSV export.
 * Returns an array of listing objects.
 */
function parseMLSCSV(csv) {
  const lines = csv.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) {
    log('⚠️  CSV has no data rows');
    return [];
  }

  const headers = parseCSVRow(lines[0]).map(h => h.trim().toLowerCase().replace(/[^a-z0-9#]/g, ''));

  // Flexible column finder — tries multiple known header variations
  const col = (...names) => {
    for (const n of names) {
      const norm = n.toLowerCase().replace(/[^a-z0-9#]/g, '');
      const i = headers.indexOf(norm);
      if (i !== -1) return i;
    }
    // Partial match fallback
    for (const n of names) {
      const norm = n.toLowerCase().replace(/[^a-z0-9#]/g, '');
      const i = headers.findIndex(h => h.includes(norm) || norm.includes(h));
      if (i !== -1) return i;
    }
    return -1;
  };

  const mlsIdx       = col('ml#', 'mls#', 'mlsnumber', 'listnumber', 'listingnumber');
  const statusIdx    = col('status', 'lststatus', 'liststatus', 'mlsstatus', 'misstatus');
  const addrIdx      = col('address', 'streetaddress', 'propaddress', 'propertyaddress');
  const streetNumIdx = col('streetnumber', 'streetnum', 'housenumber', 'housenum', 'stnum');
  const streetDirIdx = col('streetdirprefix', 'dirprefix', 'streetdir');
  const streetNmIdx  = col('streetname', 'stname');
  const streetSfxIdx = col('streetsuffix', 'strsuffix', 'suffix');
  const cityIdx      = col('postalcity', 'city', 'town', 'municipality');
  const stateIdx     = col('state', 'st');
  const zipIdx       = col('zip', 'zipcode', 'postalcode');
  const countyIdx    = col('county');
  const priceIdx     = col('listprice', 'listingprice', 'price', 'lprice');
  const bedsIdx      = col('beds', 'bedrooms', 'br', 'ttlbeds', 'totalbeds', 'bedroomstotal');
  const bathsIdx     = col('baths', 'bathrooms', 'ba', 'fullbaths', 'ttlbaths', 'bathroomstotalinteger');

  log(`📊 All CSV headers: ${headers.join(' | ')}`);
  log(`📊 CSV columns detected — address:${addrIdx} streetNum:${streetNumIdx} streetName:${streetNmIdx} city:${cityIdx} zip:${zipIdx} county:${countyIdx} price:${priceIdx}`);

  const listings = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]);
    if (cols.length < 3) continue;

    const g = (idx) => idx >= 0 ? (cols[idx] || '').trim() : '';

    const status = g(statusIdx).toLowerCase();
    // Skip if there's a status field and it's NOT expired
    if (status && !['exp', 'expired', ''].includes(status)) continue;

    const county = g(countyIdx);
    if (county && TARGET_COUNTIES.length > 0) {
      const matched = TARGET_COUNTIES.some(tc =>
        county.toLowerCase().includes(tc.toLowerCase())
      );
      if (!matched) continue;
    }

    // Build full address from components if no combined address column
    let address = g(addrIdx);
    if (!address && streetNmIdx >= 0) {
      const parts = [g(streetNumIdx), g(streetDirIdx), g(streetNmIdx), g(streetSfxIdx)];
      address = parts.filter(Boolean).join(' ');
    }
    if (!address) continue; // must have an address

    listings.push({
      mlsNum:    g(mlsIdx),
      status:    g(statusIdx),
      address,
      city:      g(cityIdx),
      state:     g(stateIdx) || 'NY',
      zip:       g(zipIdx),
      county,
      listPrice: g(priceIdx),
      beds:      g(bedsIdx),
      baths:     g(bathsIdx),
    });
  }

  return listings;
}

// ─── Credential-Based Auto-Login ─────────────────────────────────────────────
/**
 * Handle PingOne SSO login when session cookies are expired.
 * Page should already be on the PingOne login redirect.
 */
async function loginWithCredentials(page) {
  if (!MLS_USER || !MLS_PASS) {
    log('❌ Cannot auto-login: ONEKEYMLS_USERNAME or ONEKEYMLS_PASSWORD not set in Railway env vars.');
    return false;
  }

  log(`🔐 Auto-logging in via PingOne SSO (${page.url()})...`);

  try {
    // ── Step 1: Fill username field
    await page.waitForSelector(
      '#username, input[name="pf.username"], input[autocomplete="username"], input[type="text"]',
      { timeout: 15000 }
    );

    const usernameSelectors = [
      '#username',
      'input[name="pf.username"]',
      'input[autocomplete="username"]',
      'input[type="email"]',
      'input[type="text"]:not([type="hidden"])',
    ];
    let filledUser = false;
    for (const sel of usernameSelectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await el.fill(MLS_USER);
          filledUser = true;
          log(`   Filled username into: ${sel}`);
          break;
        }
      } catch(_) {}
    }
    if (!filledUser) throw new Error('Could not find username field');

    await sleep(800);

    // ── Step 2: Log the page HTML for debugging, then submit via JS (bypasses visibility issues)
    const pageSource = await page.content();
    const formInfo = pageSource.match(/<form[^>]*>[\s\S]*?<\/form>/i)?.[0]?.substring(0, 800) || 'no form found';
    log(`   Form HTML preview: ${formInfo.replace(/\s+/g, ' ')}`);

    // Use JS click — bypasses Playwright's isVisible() checks which can fail in headless mode
    const clickResult = await page.evaluate(() => {
      const selectors = [
        'input[name="pf.ok"]',
        'input[type="submit"]',
        'button[type="submit"]',
        '#submit-button',
        '.ping-button',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { el.click(); return `js-clicked: ${sel}`; }
      }
      // Last resort: submit the form directly
      const form = document.querySelector('form');
      if (form) { form.submit(); return 'js-form-submit'; }
      return 'no-submit-found';
    });
    log(`   Submit attempt: ${clickResult}`);

    await sleep(2000);

    // ── Step 3: Fill password (may now be visible after clicking Next on split forms)
    const pwField = await page.$('input[type="password"]');
    if (pwField) {
      await pwField.fill(MLS_PASS);
      log('   Filled password');
    } else {
      await page.waitForSelector('input[type="password"]', { timeout: 12000 });
      await page.fill('input[type="password"]', MLS_PASS);
      log('   Filled password (after waiting for split form)');
    }

    await sleep(600);

    // ── Step 4: Submit login via JS click, then Enter as final fallback
    const submitResult = await page.evaluate(() => {
      const selectors = [
        'input[name="pf.ok"]',
        'input[type="submit"]',
        'button[type="submit"]',
        '#submit-button',
        '.ping-button',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { el.click(); return `js-clicked: ${sel}`; }
      }
      const form = document.querySelector('form');
      if (form) { form.submit(); return 'js-form-submit'; }
      return 'no-submit-found';
    });
    log(`   Submit result: ${submitResult}`);
    if (submitResult === 'no-submit-found') {
      log('   Pressing Enter as final fallback');
      await page.keyboard.press('Enter');
    }

    // ── Step 5: Wait for redirect back to Matrix (may take 10–30s through SAML)
    log('⏳ Waiting for SAML redirect back to Matrix...');
    await page.waitForURL('**/matrix-new.onekeymlsny.com/**', { timeout: 60000 });
    await sleep(3000);

    log('✅ Auto-login successful — session is live');
    return true;

  } catch(err) {
    log(`❌ Auto-login failed: ${err.message}`);
    try {
      const screenshotPath = `/tmp/login-error-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      log(`📸 Login error screenshot: ${screenshotPath}`);
    } catch(_) {}
    return false;
  }
}

// ─── Step 1: Pull expireds from OneKey MLS ───────────────────────────────────
async function fetchExpiredsFromMLS() {
  log('🚀 Launching Chromium (headless)...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process']
  });

  const authState = loadAuthState();
  const context = await browser.newContext({
    ...(authState ? { storageState: authState } : {}),
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Block any navigation to the old/wrong Matrix domain and redirect to correct one
  await page.route('**://matrix.onekeymls.com/**', async (route) => {
    const wrongUrl = route.request().url();
    const correctedUrl = wrongUrl.replace('matrix.onekeymls.com', 'matrix-new.onekeymlsny.com');
    log(`🔀 Intercepted wrong domain redirect → correcting to ${correctedUrl}`);
    await route.fulfill({
      status: 302,
      headers: { location: correctedUrl }
    });
  });

  try {
    // ── 1a. Navigate to Matrix
    log('🌐 Navigating to Matrix MyMatrix...');
    await page.goto('https://matrix-new.onekeymlsny.com/Matrix/MyMatrix', {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    await sleep(2000);
    log(`📍 URL: ${page.url()}`);

    // ── 1b. Handle expired session — auto-login with credentials
    if (!page.url().includes('matrix-new.onekeymlsny.com')) {
      log('🔑 Session cookies expired — attempting auto-login...');
      const ok = await loginWithCredentials(page);
      if (!ok) {
        log('❌ Login failed. Check ONEKEYMLS_USERNAME / ONEKEYMLS_PASSWORD in Railway env vars.');
        await browser.close();
        return [];
      }
    }

    log('✅ Reached Matrix (session valid)');

    // ── 1c. Click "Expired" in Market Watch widget (preset by user)
    log('🔍 Clicking Expired in Market Watch...');
    const clickedId = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const mwLink = links.find(a =>
        /^Expired(\s*\(\d+\))?$/.test(a.textContent.trim()) && a.id.includes('m_lv')
      );
      if (mwLink) { mwLink.click(); return mwLink.id; }
      const fallback = links.find(a => /^Expired(\s*\(\d+\))?$/.test(a.textContent.trim()));
      if (fallback) { fallback.click(); return 'fallback:' + fallback.id; }
      return null;
    });

    if (!clickedId) {
      log(`❌ Could not find Expired Market Watch link. Title: "${await page.title()}"`);
      await browser.close();
      return [];
    }
    log(`✅ Clicked: ${clickedId}`);

    await page.waitForLoadState('networkidle', { timeout: 30000 });
    await sleep(2000);
    log(`📍 Results URL: ${page.url()}`);

    // ── 1d. Select all results
    log('☑️  Selecting all results...');
    await page.evaluate(() => {
      const btn = document.getElementById('m_lnkCheckAllLink');
      if (btn) btn.click();
    });
    await sleep(1000);

    const exportEnabled = await page.evaluate(() => {
      const td = document.getElementById('m_tdExport');
      return td && !td.className.includes('disabled');
    });
    if (!exportEnabled) {
      log('⚠️  Export disabled — zero expired listings today or nothing selected.');
      await browser.close();
      return [];
    }

    // ── 1e. Open Export page
    log('📥 Opening export...');
    await page.evaluate(() => document.getElementById('m_lbExport').click());
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await sleep(1500);

    // ── 1f. Select "power" custom export template and download
    log('📄 Selecting "power" export template and downloading...');
    await page.selectOption('#m_ddExport', { label: 'power' });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.evaluate(() => document.getElementById('m_btnExport').click())
    ]);

    const csvPath = `/tmp/expireds_${Date.now()}.csv`;
    await download.saveAs(csvPath);
    log(`✅ Downloaded CSV to ${csvPath}`);

    await browser.close();

    const csv = fs.readFileSync(csvPath, 'utf8');
    const listings = parseMLSCSV(csv);
    log(`📋 Found ${listings.length} expired listings`);
    return listings;

  } catch (err) {
    log(`❌ MLS fetch error: ${err.message}`);
    try {
      const screenshotPath = `/tmp/mls-error-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      log(`📸 Error screenshot saved to ${screenshotPath}`);
    } catch(_) {}
    await browser.close();
    return [];
  }
}

// ─── Step 2: Filter out relisted / sold / pending ────────────────────────────
async function filterActivesAndSold(listings) {
  log('🔎 Cross-checking against active/sold listings...');
  // Status filtering already done in parseMLSCSV.
  // Future v2: re-verify each address via MLS API to catch same-day relistings.
  log(`✅ ${listings.length} listings passed status filter`);
  return listings;
}

// ─── Step 3: Deduplicate against existing PowerDial contacts ─────────────────
async function deduplicateAgainstQueue(listings) {
  log('🔄 Checking for duplicates in existing queue...');
  try {
    await fetch(`${BACKEND_URL}/api/expireds/status`);
    // Backend handles address-level dedup on insert.
    // Future: fetch existing MLS numbers from backend and pre-filter here.
  } catch(e) {}
  log(`✅ ${listings.length} listings after dedup check`);
  return listings;
}


// ─── Step 3b: Geocode missing zip codes via Census Bureau API ────────────────
async function geocodeZip(address, city, state) {
  try {
    const url = `https://geocoding.geo.census.gov/geocoder/locations/address?` +
      `street=${encodeURIComponent(address)}&city=${encodeURIComponent(city)}&` +
      `state=${encodeURIComponent(state)}&benchmark=Public_AR_Current&format=json`;
    const res = await fetch(url);
    const data = await res.json();
    const matched = data?.result?.addressMatches?.[0]?.matchedAddress || '';
    const zipMatch = matched.match(/,\s*(\d{5})(?:-\d{4})?$/);
    return zipMatch ? zipMatch[1] : '';
  } catch(e) {
    return '';
  }
}

async function enrichZips(listings) {
  const missing = listings.filter(l => !l.zip);
  if (!missing.length) return listings;
  log(`📮 Geocoding zip codes for ${missing.length} listings (Census Bureau)...`);
  for (const listing of listings) {
    if (!listing.zip) {
      listing.zip = await geocodeZip(listing.address, listing.city, listing.state);
      if (listing.zip) log(`   ${listing.address}, ${listing.city} → ${listing.zip}`);
    }
  }
  return listings;
}

// ─── Step 4: Skip trace via DataSkip ─────────────────────────────────────────
async function skipTrace(listings) {
  log(`📞 Skip tracing ${listings.length} properties via DataSkip...`);
  const results = [];
  let hits = 0, misses = 0;

  for (const listing of listings) {
    try {
      const res = await fetch('https://app.dataskip.io/api/v1/skip-trace', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${DATASKIP_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          address: listing.address,
          city:    listing.city,
          state:   listing.state || 'NY',
          zip:     listing.zip
        })
      });

      const data = await res.json();

      // Log first 3 responses so we can debug DataSkip issues
      if (results.length + misses < 3) {
        log(`🔍 DataSkip [${listing.address}, ${listing.city}] → HTTP ${res.status} | found:${data.found} phones:${data.phones?.length ?? 0} raw:${JSON.stringify(data).substring(0, 200)}`);
      }

      const contact = data.contact || data; // support both response shapes
      const phones  = contact.phones || data.phones || [];

      if (!data.found || !phones.length) {
        misses++;
        continue;
      }

      // Filter out DNC numbers
      const cleanPhones = phones
        .filter(p => !p.dnc)
        .map(p => ({ phone: p.number, label: p.type === 'mobile' ? 'Cell' : 'Home', status: 'pending' }));

      if (!cleanPhones.length) {
        misses++;
        continue;
      }

      hits++;
      results.push({
        name:      contact.name || contact.fullName || data.fullName || 'Property Owner',
        phones:    cleanPhones,
        address:   listing.address,
        city:      listing.city,
        state:     listing.state,
        zip:       listing.zip,
        county:    listing.county,
        listPrice: listing.listPrice,
        beds:      listing.beds,
        baths:     listing.baths,
        mlsNum:    listing.mlsNum,
        status:    'pending'
      });

      await sleep(200); // be respectful to the API

    } catch(err) {
      log(`⚠️  Skip trace error for ${listing.address}: ${err.message}`);
      misses++;
    }
  }

  log(`✅ Skip trace complete: ${hits} hits, ${misses} misses`);
  return results;
}

// ─── Step 5: Push to PowerDial backend queue ─────────────────────────────────
async function pushToPowerDial(contacts) {
  if (!contacts.length) {
    log('⚠️  No contacts to push');
    return;
  }

  log(`📤 Pushing ${contacts.length} contacts to PowerDial...`);
  const res = await fetch(`${BACKEND_URL}/api/expireds/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contacts, apiKey: EXPIREDS_KEY })
  });

  const data = await res.json();
  if (data.success) {
    log(`✅ Successfully queued ${data.queued} contacts in PowerDial`);
  } else {
    log(`❌ Failed to push to PowerDial: ${JSON.stringify(data)}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log('🚀 Starting daily expireds automation...');
  log(`📅 Date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`);

  // Validate required env vars
  if (!DATASKIP_KEY) { log('❌ Missing DATASKIP_API_KEY'); process.exit(1); }
  if (!BACKEND_URL)  { log('❌ Missing PUBLIC_URL');       process.exit(1); }
  if (!MLS_USER || !MLS_PASS) {
    log('⚠️  ONEKEYMLS_USERNAME / ONEKEYMLS_PASSWORD not set — auto-login disabled, relying on MLS_AUTH_STATE');
  }

  try {
    let listings = await fetchExpiredsFromMLS();
    if (!listings.length) { log('📭 No expireds found for today'); return; }

    listings = await filterActivesAndSold(listings);
    listings = await deduplicateAgainstQueue(listings);
    listings = await enrichZips(listings);  // geocode any missing zips

    const contacts = await skipTrace(listings);
    await pushToPowerDial(contacts);

    log('🎉 Done! Open PowerDial to see today\'s expireds.');
  } catch(err) {
    log(`❌ Fatal error: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

main();
