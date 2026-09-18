/**
 * setup-auth.js — One-time Matrix authentication setup
 *
 * Run this ONCE on your local machine to save your Matrix session:
 *   node setup-auth.js
 *
 * A browser window will open. Log into Matrix normally.
 * Once you see the MyMatrix page, come back here and press Enter.
 * Your session is saved to mls-auth.json.
 *
 * Then run encode-auth.js to get the value for Railway's MLS_AUTH_STATE env var.
 */

require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const AUTH_FILE = path.join(__dirname, 'mls-auth.json');

async function main() {
  console.log('🌐 Opening browser — please log into Matrix...');
  console.log('   URL: https://matrix-new.onekeymlsny.com/Matrix/MyMatrix\n');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 50,
    args: ['--start-maximized']
  });

  const context = await browser.newContext({
    viewport: null,  // use full window
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  // Navigate to Matrix — will redirect to SSO
  await page.goto('https://matrix-new.onekeymlsny.com/Matrix/MyMatrix', {
    waitUntil: 'networkidle',
    timeout: 30000
  });

  console.log('📋 Log in with your OneKey credentials.');
  console.log('   After you reach the MyMatrix dashboard, come back here.\n');

  // Wait for user to log in manually
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => {
    rl.question('✅ Press ENTER once you are logged into MyMatrix: ', () => {
      rl.close();
      resolve();
    });
  });

  // Verify we're on Matrix
  const url = page.url();
  if (!url.includes('matrix-new.onekeymlsny.com')) {
    console.log(`⚠️  Warning: current URL is ${url}`);
    console.log('   Make sure you are on the Matrix page before continuing.');
  } else {
    console.log(`✅ Confirmed on Matrix: ${url}`);
  }

  // Save the full storage state (cookies + localStorage)
  const state = await context.storageState();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2));
  console.log(`\n💾 Auth state saved to: ${AUTH_FILE}`);
  console.log(`   Cookies captured: ${state.cookies.length}`);
  console.log(`   Origins with storage: ${state.origins.length}`);

  await browser.close();
  console.log('\n🎉 Done! Now run: node encode-auth.js');
  console.log('   Copy the output and paste it into Railway as MLS_AUTH_STATE');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
