const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const storeDir = path.join(__dirname, '..', '.tmp-test-data');
const balancesPath = path.join(storeDir, 'user-balances.json');
const receiptsPath = path.join(storeDir, 'processed-receipts.json');

process.env.STAR_MOBILE_BALANCES_FILE = balancesPath;
process.env.STAR_MOBILE_RECEIPTS_FILE = receiptsPath;

function loadFreshModule() {
  const modulePath = require.resolve('../starMobileApi');
  delete require.cache[modulePath];
  return require('../starMobileApi');
}

function resetStores() {
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(balancesPath, '{}', 'utf8');
  fs.writeFileSync(receiptsPath, '[]', 'utf8');
}

test('creditUserAccount adds amount to current balance and stores it persistently', async () => {
  resetStores();
  const { creditUserAccount, getUserAccount } = loadFreshModule();

  const first = await creditUserAccount('770326828', 239, 'RCP-001');
  assert.equal(first.newBalance, 239);

  const second = await creditUserAccount('770326828', 500, 'RCP-002');
  assert.equal(second.oldBalance, 239);
  assert.equal(second.newBalance, 739);

  const saved = await getUserAccount('770326828');
  assert.equal(saved.balance, 739);
});

test('duplicate receipt is rejected even if same receipt is sent twice', async () => {
  resetStores();
  const { creditUserAccount, isReceiptProcessed } = loadFreshModule();

  const first = await creditUserAccount('771234567', 100, 'DUP-777');
  assert.equal(first.success, true);

  const second = await creditUserAccount('771234567', 150, 'DUP-777');
  assert.equal(second.success, false);
  assert.equal(second.alreadyProcessed, true);
  assert.equal(isReceiptProcessed('DUP-777'), true);
});
