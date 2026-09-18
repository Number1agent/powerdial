/**
 * encode-auth.js — Encodes mls-auth.json for Railway
 *
 * Run after setup-auth.js:
 *   node encode-auth.js
 *
 * Copy the printed value and add it to Railway as:
 *   Variable name:  MLS_AUTH_STATE
 *   Variable value: <paste here>
 *
 * The auth state expires when your Matrix session expires.
 * Re-run setup-auth.js + encode-auth.js to refresh it.
 */

const fs = require('fs');
const path = require('path');

const AUTH_FILE = path.join(__dirname, 'mls-auth.json');

if (!fs.existsSync(AUTH_FILE)) {
  console.error('❌ mls-auth.json not found. Run setup-auth.js first.');
  process.exit(1);
}

const raw = fs.readFileSync(AUTH_FILE, 'utf8');
const state = JSON.parse(raw);
const encoded = Buffer.from(raw).toString('base64');

console.log(`\n📊 Auth state contains:`);
console.log(`   ${state.cookies.length} cookies`);
console.log(`   ${state.origins.length} origin storage entries`);
console.log(`   Encoded size: ${encoded.length} chars\n`);
console.log('━━━ Copy everything below this line ━━━\n');
console.log(encoded);
console.log('\n━━━ Copy everything above this line ━━━');
console.log('\n📋 Paste this value into Railway as: MLS_AUTH_STATE');
