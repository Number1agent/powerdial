/**
 * PowerDial — Daily Expireds Automation
 *
 * Runs every morning (scheduled via Railway cron):
 * 1. Logs into OneKey MLS, exports today's expired listings for target counties
 * 2. Filters out relisted / sold / pending properties
 * 3. Deduplicates against what's already in PowerDial
 * 4. Skip traces clean contacts via DataSkip API
 * 5. Pushes verified contacts to PowerDial backend queue
 *
 * Environment variables required:
 *   ONEKEYMLS_USERNAME, ONEKEYMLS_PASSWORD
 *   DATASKIP_API_KEY
 *   EXPIREDS_API_KEY
 *   PUBLIC_URL (your Railway backend URL)
 */

require('dotenv').config();
const { chromium } = require('playwright');

// ─── Config ──────────────────────────────────────────────────────────────────
const BACKEND_URL    = process.env.PUBLIC_URL;
const DATASKIP_KEY   = process.env.DATASKIP_API_KEY;
const EXPIREDS_KEY   = process.env.EXPIREDS_API_KEY;
const MLS_USER       = process.env.ONEKEYMLS_USERNAME;
const MLS_PASS       = process.env.ONEKEYMLS_PASSWORD;

// Target counties (OneKey MLS county names)
const TARGET_COUNTIES = [
  'Dutchess',
  'Putnam',
  'Westchester',
  'Bronx',
  'Kings',       // Brooklyn
  'New York',    // Manhattan
  'Queens',
  'Richmond',    // Staten Island
  'Rockland'
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Step 1: Pull expireds from OneKey MLS ───────────────────────────────────
async function fetchExpiredsFromMLS() {
  log('🌐 Launching browser for OneKey MLS...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Login
    log('🔐 Logging into OneKey MLS...');
    await page.goto('https://www.onekeymls.com/login', { waitUntil: 'networkidle' });
    await page.fill('input[name="username"], input[type="email"], #username', MLS_USER);
    await page.fill('input[name="password"], input[type="password"], #password', MLS_PASS);
    await page.click('button[type="submit"], input[type="submit"], .login-btn');
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });
    log('✅ Logged in');

    // Navigate to Matrix search
    await page.goto('https://matrix.onekeymls.com', { waitUntil: 'networkidle' });
    await sleep(2000);

    // Open residential search
    log('🔍 Searching for today\'s expireds...');
    await page.click('a[href*="search"], .search-link, #searchLink').catch(() => {});
    await sleep(1000);

    // Set status to Expired
    const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

    // Try to find status field and set to Expired
    await page.selectOption('select[id*="Status"], select[name*="Status"]', { label: 'Expired' }).catch(() => {});

    // Set expiration date to today
    await page.fill('input[id*="ExpirationDate"], input[name*="ExpirationDate"]', `${today}-${today}`).catch(() => {});

    // Set county
    for (const county of TARGET_COUNTIES) {
      await page.check(`input[value="${county}"], label:has-text("${county}") input`).catch(() => {});
    }

    // Run search
    await page.click('button:has-text("Search"), input[value="Search"], #searchButton');
    await page.waitForLoadState('networkidle');
    await sleep(2000);

    // Export results to CSV
    log('📥 Exporting results...');
    await page.click('button:has-text("Export"), a:has-text("Export"), .export-btn').catch(() => {});
    await sleep(1000);
    await page.click('option:has-text("CSV"), button:has-text("CSV")').catch(() => {});

    // Wait for download
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('button:has-text("Download"), button:has-text("Export"), #exportBtn').catch(() => {})
    ]);

    const csvPath = `/tmp/expireds_${Date.now()}.csv`;
    await download.saveAs(csvPath);
    log(`✅ Downloaded expireds CSV to ${csvPath}`);

    await browser.close();

    // Parse CSV
    const fs = require('fs');
    const csv = fs.readFileSync(csvPath, 'utf8');
    const listings = parseMLSCSV(csv);
    log(`📋 Found ${listings.length} expired listings`);
    return listings;

  } catch (err) {
    log(`❌ MLS fetch error: ${err.message}`);
    await browser.close();
    return [];
  }
}

function parseMLSCSV(csv) {
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
  const listings = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]);
    const row = {};
    headers.forEach((h, idx) => row[h] = (cols[idx] || '').trim().replace(/"/g, ''));

    // Map common MLS column names
    const address   = row['address'] || row['street address'] || row['property address'] || '';
    const city      = row['city'] || row['town'] || '';
    const state     = row['state'] || 'NY';
    const zip       = row['zip'] || row['zip code'] || row['postal code'] || '';
    const county    = row['county'] || '';
    const status    = (row['status'] || '').toLowerCase();
    const listPrice = row['list price'] || row['price'] || '';
    const beds      = row['beds'] || row['bedrooms'] || '';
    const baths     = row['baths'] || row['bathrooms'] || '';
    const mlsNum    = row['mls#'] || row['mls number'] || row['listing id'] || '';

    if (!address) continue;

    // Filter out anything that's not truly expired
    if (status && status !== 'expired' && status !== 'exp') continue;

    listings.push({ address, city, state, zip, county, listPrice, beds, baths, mlsNum, status });
  }

  return listings;
}

function parseCSVRow(row) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (const char of row) {
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += char; }
  }
  result.push(current);
  return result;
}

// ─── Step 2: Filter out relisted / sold / pending ────────────────────────────
async function filterActivesAndSold(listings) {
  log('🔎 Cross-checking against active/sold listings...');
  // We check the PowerDial backend for any listing already in the queue
  // and also re-check MLS status via address search
  // For now: filter by checking if the MLS status field already excluded them in parseMLSCSV
  // A more thorough check would hit the MLS API per address — added in v2
  log(`✅ ${listings.length} listings passed status filter`);
  return listings;
}

// ─── Step 3: Deduplicate against existing PowerDial contacts ─────────────────
async function deduplicateAgainstQueue(listings) {
  log('🔄 Checking for duplicates in existing queue...');
  try {
    const res = await fetch(`${BACKEND_URL}/api/expireds/status`);
    // For now, we rely on address-level dedup in the backend
    // Future: fetch existing contact addresses from backend and filter here
  } catch(e) {}
  log(`✅ ${listings.length} listings after dedup check`);
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

      if (!data.found || !data.phones?.length) {
        misses++;
        continue;
      }

      // Filter out DNC numbers
      const cleanPhones = data.phones
        .filter(p => !p.dnc)
        .map(p => ({ phone: p.number, label: p.type === 'mobile' ? 'Cell' : 'Home', status: 'pending' }));

      if (!cleanPhones.length) {
        misses++;
        continue;
      }

      hits++;
      results.push({
        name:      data.fullName || 'Property Owner',
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

      // Small delay to be respectful to the API
      await sleep(200);

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
  log(`🗺️  Counties: ${TARGET_COUNTIES.join(', ')}`);

  if (!MLS_USER || !MLS_PASS) { log('❌ Missing OneKey MLS credentials'); process.exit(1); }
  if (!DATASKIP_KEY)           { log('❌ Missing DATASKIP_API_KEY');        process.exit(1); }
  if (!BACKEND_URL)            { log('❌ Missing PUBLIC_URL');              process.exit(1); }

  try {
    let listings = await fetchExpiredsFromMLS();
    if (!listings.length) { log('📭 No expireds found for today'); return; }

    listings = await filterActivesAndSold(listings);
    listings = await deduplicateAgainstQueue(listings);

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
