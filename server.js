'use strict';

/**
 * TreaderBooom — DEMO/SANDBOX backend
 * Node.js 18+ | npm i express telegraf dotenv
 *
 * This server intentionally supports simulated balances and simulated requests only.
 * It does NOT connect to crypto wallets, payment processors, exchanges or blockchain networks.
 *
 * Required .env:
 * PORT=3000
 * TELEGRAM_BOT_TOKEN=...
 * ADMIN_TELEGRAM_IDS=123456789,987654321
 * ADMIN_API_KEY=use-a-long-random-secret-here
 * WEBAPP_ORIGIN=https://your-mini-app-domain.example
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.static(__dirname));

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const ADMIN_IDS = new Set((process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',').map(v => v.trim()).filter(Boolean));
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  config: 'config.json', users: 'users.json', deposits: 'deposits.json',
  withdrawals: 'withdrawals.json', trades: 'trades.json',
  giftCodes: 'giftcodes.json', transactions: 'transactions.json',
  referrals: 'referrals.json', bonuses: 'bonuses.json',
  announcements: 'announcements.json', audit: 'audit.json',
  admins: 'admins.json'
};
const defaults = {
  appName: 'TreaderBooom Demo',
  demoMode: true,
  tradingEnabled: true,
  maintenanceEnabled: false,
  maintenanceMessage: 'The app is temporarily unavailable. Please try again later.',
  tradeDuration: 60,
  multiplier: 1.8,
  minStake: 0.001,
  maxStake: 100,
  cancelEnabled: true,
  enabledPairs: ['BTC/USDT', 'ETH/USDT', 'BNB/USDT'],
  depositEnabled: true,
  withdrawEnabled: true,
  minDeposit: 1,
  minWithdraw: 1,
  maxWithdraw: 10000,
  networkFee: 0,
  welcomeBonusEnabled: false,
  welcomeBonusAmount: 0,
  turnoverRequirement: 0,
  referralEnabled: false,
  referralRate: 0,
  announcementEnabled: true,
  communityUrl: '',
  supportUrl: '',
  botUsername: '',
  depositWalletAddress: '',
  announcementMessage: ''
};

function readJson(name, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(DATA_DIR, FILES[name]), 'utf8'));
    return value ?? fallback;
  } catch { return fallback; }
}
function writeJson(name, value) {
  const target = path.join(DATA_DIR, FILES[name]);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, target);
}
const db = {};
for (const [key, fallback] of Object.entries({
  config: defaults, users: {}, deposits: [], withdrawals: [], trades: [],
  giftCodes: [], transactions: [], referrals: [], bonuses: [],
  announcements: [], audit: [], admins: []
})) db[key] = readJson(key, fallback);
db.config = { ...defaults, ...db.config, demoMode: true };

const save = key => writeJson(key, db[key]);
const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const num = value => Number.isFinite(Number(value)) ? Number(value) : NaN;
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
function audit(actor, action, details = {}) {
  db.audit.push({ id: id('audit'), actor: String(actor || 'system'), action, details, at: now() });
  db.audit = db.audit.slice(-10000);
  save('audit');
}
function addTransaction(userId, type, amount, details = {}) {
  const item = { id: id('txn'), userId: String(userId), type, amount: Number(amount),
    balanceAfter: Number(db.users[String(userId)]?.balance || 0), details, at: now() };
  db.transactions.push(item);
  db.transactions = db.transactions.slice(-30000);
  save('transactions');
  return item;
}
function getUser(userId) { return db.users[String(userId)]; }
function isOnline(user) {
  return user.lastSeen && Date.now() - new Date(user.lastSeen).getTime() < 5 * 60 * 1000;
}
function csvCell(v) { return `"${String(v ?? '').replace(/"/g, '""')}"`; }
function sendJsonError(res, status, message) { return res.status(status).json({ ok: false, error: message }); }

// Maintenance guard for app APIs.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') && !req.path.startsWith('/api/admin') &&
      db.config.maintenanceEnabled && !['/api/health', '/api/config'].includes(req.path)) {
    return sendJsonError(res, 503, db.config.maintenanceMessage);
  }
  next();
});

// Telegram Mini App initData validation.
function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData || typeof initData !== 'string') return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqual(expected, hash)) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400 || authDate > Date.now() / 1000 + 60) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user?.id ? user : null;
  } catch { return null; }
}
function miniSession(req, res, next) {
  const user = verifyTelegramInitData(req.body?.initData || req.headers['x-telegram-init-data']);
  if (!user) return sendJsonError(res, 401, 'A valid Telegram Mini App session is required.');
  req.telegramUser = user;
  next();
}
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!ADMIN_API_KEY || !safeEqual(key, ADMIN_API_KEY)) {
    return sendJsonError(res, 401, 'Admin authentication failed.');
  }
  req.adminId = req.headers['x-admin-id'] || 'api-admin';
  next();
}
function ensureUser(tgUser) {
  const userId = String(tgUser.id);
  if (!db.users[userId]) {
    db.users[userId] = {
      id: userId, firstName: tgUser.first_name || '', lastName: tgUser.last_name || '',
      username: tgUser.username || '', balance: 0, blocked: false, active: true,
      adminNote: '', createdAt: now(), lastSeen: now(), referredBy: null
    };
    save('users');
    audit(userId, 'user.registered');
    if (db.config.welcomeBonusEnabled && db.config.welcomeBonusAmount > 0) {
      const amount = Number(db.config.welcomeBonusAmount);
      db.users[userId].balance += amount;
      save('users');
      addTransaction(userId, 'welcome_bonus', amount);
      db.bonuses.push({ id: id('bonus'), userId, amount, type: 'welcome', at: now() });
      save('bonuses');
    }
  }
  db.users[userId].lastSeen = now();
  db.users[userId].username = tgUser.username || db.users[userId].username || '';
  save('users');
  return db.users[userId];
}
function requireUser(req, res, next) {
  const user = getUser(req.telegramUser.id);
  if (!user) return sendJsonError(res, 404, 'User session not initialized.');
  if (user.blocked || user.active === false) return sendJsonError(res, 403, 'This account is unavailable.');
  req.appUser = user;
  next();
}
function filterDate(items, from, to) {
  return items.filter(x => (!from || x.at >= from) && (!to || x.at <= to));
}
function paged(items, req) {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const page = Math.max(1, Number(req.query.page) || 1);
  return { items: items.slice((page - 1) * limit, page * limit), total: items.length, page, limit };
}

// Basic health/config endpoints.
app.get('/api/health', (_req, res) => res.json({ ok: true, app: db.config.appName, mode: 'demo' }));
app.get('/api/config', (_req, res) => {
  const c = db.config;
  res.json({
    appName: c.appName, demoMode: true, tradingEnabled: c.tradingEnabled,
    maintenanceEnabled: c.maintenanceEnabled, maintenanceMessage: c.maintenanceMessage,
    tradeDuration: c.tradeDuration, multiplier: c.multiplier, minStake: c.minStake,
    maxStake: c.maxStake, cancelEnabled: c.cancelEnabled, enabledPairs: c.enabledPairs,
    depositEnabled: c.depositEnabled, withdrawEnabled: c.withdrawEnabled,
    minDeposit: c.minDeposit, minWithdraw: c.minWithdraw, maxWithdraw: c.maxWithdraw,
    networkFee: c.networkFee, supportUrl: c.supportUrl, communityUrl: c.communityUrl,
    announcementEnabled: c.announcementEnabled, announcementMessage: c.announcementMessage
  });
});

// Mini App user endpoints.
app.post('/api/session', miniSession, (req, res) => {
  const user = ensureUser(req.telegramUser);
  if (user.blocked || user.active === false) return sendJsonError(res, 403, 'This account is unavailable.');
  res.json({ ok: true, user: { id: user.id, first_name: user.firstName,
    username: user.username, balance: user.balance, status: user.active ? 'active' : 'inactive' },
    config: { appName: db.config.appName, demoMode: true } });
});
app.get('/api/me', miniSession, requireUser, (req, res) => res.json({ ok: true, user: req.appUser }));
app.get('/api/history', miniSession, requireUser, (req, res) => {
  const uid = String(req.telegramUser.id);
  res.json({
    deposits: db.deposits.filter(x => x.userId === uid),
    withdrawals: db.withdrawals.filter(x => x.userId === uid),
    trades: db.trades.filter(x => x.userId === uid),
    transactions: db.transactions.filter(x => x.userId === uid)
  });
});

// Demo-only deposit request. No wallet verification or actual transfer is performed.
app.post('/api/deposit/submit', miniSession, requireUser, (req, res) => {
  if (!db.config.depositEnabled) return sendJsonError(res, 403, 'Demo deposits are disabled.');
  const amount = num(req.body.amount);
  const reference = String(req.body.txid || req.body.reference || '').trim();
  if (!Number.isFinite(amount) || amount < Number(db.config.minDeposit) || amount > 1000000 || !reference) {
    return sendJsonError(res, 400, 'Enter a valid demo amount and reference.');
  }
  if (db.deposits.some(x => x.reference.toLowerCase() === reference.toLowerCase())) {
    return sendJsonError(res, 409, 'This reference has already been used.');
  }
  const item = { id: id('dep'), userId: String(req.telegramUser.id),
    userName: req.appUser.firstName || 'User', amount, reference,
    txid: reference, status: 'pending', at: now(), mode: 'demo' };
  db.deposits.push(item); save('deposits'); audit(item.userId, 'demo.deposit.submitted', { depositId: item.id, amount });
  notifyAdmins(`New DEMO deposit request: ${item.userName} (${item.userId}), ${amount} demo USDT.`);
  res.json({ ok: true, message: 'Demo request submitted.', deposit: item });
});

// Demo-only withdrawal request. The virtual amount is reserved immediately.
app.post('/api/withdraw/submit', miniSession, requireUser, (req, res) => {
  if (!db.config.withdrawEnabled) return sendJsonError(res, 403, 'Demo withdrawals are disabled.');
  const amount = num(req.body.amount);
  const wallet = String(req.body.walletAddress || req.body.address || '').trim();
  if (!Number.isFinite(amount) || amount < Number(db.config.minWithdraw) ||
      amount > Number(db.config.maxWithdraw) || !wallet || amount + Number(db.config.networkFee) > req.appUser.balance) {
    return sendJsonError(res, 400, 'Invalid demo withdrawal details or insufficient demo balance.');
  }
  const fee = Number(db.config.networkFee);
  const item = { id: id('wd'), userId: String(req.telegramUser.id), amount,
    fee, netAmount: Math.max(0, amount - fee), walletAddress: wallet,
    status: 'pending', at: now(), mode: 'demo', paymentHash: '' };
  req.appUser.balance -= amount; save('users');
  db.withdrawals.push(item); save('withdrawals');
  addTransaction(item.userId, 'demo_withdrawal_reserved', -amount, { withdrawalId: item.id });
  audit(item.userId, 'demo.withdrawal.submitted', { withdrawalId: item.id, amount });
  notifyAdmins(`New DEMO withdrawal request: user ${item.userId}, ${amount} demo USDT.`);
  res.json({ ok: true, message: 'Demo withdrawal request submitted.', withdrawal: item });
});

// Demo trade history endpoint. The client must send a simulated result; never represents a live market order.
app.post('/api/demo/trades', miniSession, requireUser, (req, res) => {
  if (!db.config.tradingEnabled || db.config.maintenanceEnabled) return sendJsonError(res, 403, 'Demo trading is paused.');
  const amount = num(req.body.amount);
  const pair = String(req.body.pair || '').trim();
  const direction = String(req.body.direction || '').toLowerCase();
  const result = String(req.body.result || '').toLowerCase();
  if (!Number.isFinite(amount) || amount < Number(db.config.minStake) || amount > Number(db.config.maxStake) ||
      !db.config.enabledPairs.includes(pair) || !['rise', 'fall'].includes(direction) ||
      !['win', 'loss', 'cancelled'].includes(result)) {
    return sendJsonError(res, 400, 'Invalid demo trade data.');
  }
  if (amount > req.appUser.balance) return sendJsonError(res, 400, 'Insufficient demo balance.');
  const item = { id: id('trade'), userId: String(req.telegramUser.id), pair, direction,
    amount, duration: Number(db.config.tradeDuration), result, at: now(), mode: 'demo' };
  if (result === 'cancelled' && !db.config.cancelEnabled) return sendJsonError(res, 403, 'Trade cancellation is disabled.');
  req.appUser.balance -= amount;
  if (result === 'win') req.appUser.balance += amount * Number(db.config.multiplier);
  if (result === 'cancelled') req.appUser.balance += amount;
  save('users'); db.trades.push(item); save('trades');
  addTransaction(item.userId, `demo_trade_${result}`, result === 'win'
    ? amount * (Number(db.config.multiplier) - 1) : result === 'loss' ? -amount : 0, { tradeId: item.id });
  res.json({ ok: true, trade: item, balance: req.appUser.balance });
});

// Referrals: invitee can submit a referrer ID once.
app.post('/api/referral/attach', miniSession, requireUser, (req, res) => {
  const referrerId = String(req.body.referrerId || '').trim();
  const inviteeId = String(req.telegramUser.id);
  if (!referrerId || referrerId === inviteeId || !getUser(referrerId) || req.appUser.referredBy) {
    return sendJsonError(res, 400, 'Referral cannot be attached.');
  }
  req.appUser.referredBy = referrerId; save('users');
  db.referrals.push({ id: id('ref'), referrerId, inviteeId, level: 1, at: now() });
  save('referrals'); audit(inviteeId, 'referral.attached', { referrerId });
  res.json({ ok: true });
});

// Gift code redemption with expiry, usage cap and per-user duplicate protection.
app.post('/api/giftcode/redeem', miniSession, requireUser, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const gift = db.giftCodes.find(x => x.code === code && x.active !== false);
  if (!gift) return sendJsonError(res, 404, 'Gift code not found or inactive.');
  if (gift.expiresAt && new Date(gift.expiresAt).getTime() < Date.now()) return sendJsonError(res, 400, 'Gift code expired.');
  if ((gift.redeemedBy || []).includes(String(req.telegramUser.id))) return sendJsonError(res, 409, 'You have already redeemed this code.');
  if (gift.maxUses && gift.redeemedBy.length >= gift.maxUses) return sendJsonError(res, 409, 'Gift code usage limit reached.');
  const amount = Number(gift.amount);
  req.appUser.balance += amount; save('users');
  gift.redeemedBy.push(String(req.telegramUser.id)); gift.redeemedAt = now(); save('giftCodes');
  addTransaction(String(req.telegramUser.id), 'giftcode_reward', amount, { code });
  audit(String(req.telegramUser.id), 'giftcode.redeemed', { code, amount });
  notifyAdmins(`Gift code ${code} redeemed by ${req.telegramUser.id}.`);
  res.json({ ok: true, amount, balance: req.appUser.balance });
});

// Referral summary for a signed-in user.
app.get('/api/referral/me', miniSession, requireUser, (req, res) => {
  const uid = String(req.telegramUser.id);
  res.json({ ok: true, referralLink: `https://t.me/${db.config.botUsername || 'YOUR_BOT'}?start=${uid}`,
    invited: db.referrals.filter(x => x.referrerId === uid) });
});

// ----------------------- ADMIN REST API -----------------------
app.use('/api/admin', adminAuth);
app.get('/api/admin/dashboard', (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const todayDeposits = db.deposits.filter(x => x.at.startsWith(today));
  const todayWithdrawals = db.withdrawals.filter(x => x.at.startsWith(today));
  const pendingDeposits = db.deposits.filter(x => x.status === 'pending');
  const pendingWithdrawals = db.withdrawals.filter(x => x.status === 'pending');
  const trades = db.trades;
  res.json({
    demoMode: true,
    totalRegisteredUsers: Object.keys(db.users).length,
    onlineUsers: Object.values(db.users).filter(isOnline).length,
    activeUsers: Object.values(db.users).filter(x => x.active !== false && !x.blocked).length,
    totalDeposits: db.deposits.filter(x => x.status === 'approved').reduce((s, x) => s + x.amount, 0),
    totalWithdrawals: db.withdrawals.filter(x => x.status === 'approved').reduce((s, x) => s + x.amount, 0),
    pendingDepositRequests: pendingDeposits.length,
    pendingWithdrawRequests: pendingWithdrawals.length,
    totalTrades: trades.length,
    winningTrades: trades.filter(x => x.result === 'win').length,
    losingTrades: trades.filter(x => x.result === 'loss').length,
    totalReferrals: db.referrals.length,
    giftCodeRedeems: db.giftCodes.reduce((s, x) => s + (x.redeemedBy || []).length, 0),
    totalUserBalance: Object.values(db.users).reduce((s, x) => s + Number(x.balance || 0), 0),
    today: {
      deposits: todayDeposits.reduce((s, x) => s + x.amount, 0),
      withdrawals: todayWithdrawals.reduce((s, x) => s + x.amount, 0),
      depositRequests: todayDeposits.length, withdrawalRequests: todayWithdrawals.length
    }
  });
});

// Users: list, details, activity, status, block, notes and virtual balance adjustment.
app.get('/api/admin/users', (req, res) => {
  let list = Object.values(db.users);
  const q = String(req.query.q || '').toLowerCase();
  if (q) list = list.filter(u => String(u.id).includes(q) || (u.username || '').toLowerCase().includes(q) ||
    (u.firstName || '').toLowerCase().includes(q));
  if (req.query.status === 'blocked') list = list.filter(u => u.blocked);
  if (req.query.status === 'inactive') list = list.filter(u => u.active === false);
  if (req.query.status === 'active') list = list.filter(u => !u.blocked && u.active !== false);
  list.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  res.json(paged(list, req));
});
app.get('/api/admin/users/:userId', (req, res) => {
  const u = getUser(req.params.userId);
  if (!u) return sendJsonError(res, 404, 'User not found.');
  res.json({ user: u, deposits: db.deposits.filter(x => x.userId === u.id),
    withdrawals: db.withdrawals.filter(x => x.userId === u.id),
    trades: db.trades.filter(x => x.userId === u.id),
    transactions: db.transactions.filter(x => x.userId === u.id),
    referrals: db.referrals.filter(x => x.referrerId === u.id || x.inviteeId === u.id) });
});
app.patch('/api/admin/users/:userId', (req, res) => {
  const u = getUser(req.params.userId);
  if (!u) return sendJsonError(res, 404, 'User not found.');
  if (typeof req.body.blocked === 'boolean') u.blocked = req.body.blocked;
  if (typeof req.body.active === 'boolean') u.active = req.body.active;
  if (typeof req.body.adminNote === 'string') u.adminNote = req.body.adminNote.slice(0, 2000);
  save('users'); audit(req.adminId, 'user.updated', { userId: u.id });
  res.json({ ok: true, user: u });
});
app.post('/api/admin/users/:userId/balance', (req, res) => {
  const u = getUser(req.params.userId);
  const amount = num(req.body.amount);
  const reason = String(req.body.reason || '').trim();
  if (!u) return sendJsonError(res, 404, 'User not found.');
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000000 || !reason) {
    return sendJsonError(res, 400, 'A non-zero amount and reason are required.');
  }
  if (u.balance + amount < 0) return sendJsonError(res, 400, 'Adjustment would make balance negative.');
  u.balance += amount; save('users');
  addTransaction(u.id, 'admin_demo_adjustment', amount, { reason, adminId: req.adminId });
  audit(req.adminId, 'user.demo_balance_adjusted', { userId: u.id, amount, reason });
  res.json({ ok: true, balance: u.balance });
});

// Deposit management.
app.get('/api/admin/deposits', (req, res) => {
  let list = filterDate(db.deposits, req.query.from, req.query.to);
  if (req.query.status) list = list.filter(x => x.status === req.query.status);
  if (req.query.q) list = list.filter(x => x.userId.includes(String(req.query.q)) || x.reference.includes(String(req.query.q)));
  list.sort((a, b) => b.at.localeCompare(a.at)); res.json(paged(list, req));
});
app.post('/api/admin/deposits/:id/approve', (req, res) => {
  const item = db.deposits.find(x => x.id === req.params.id);
  if (!item) return sendJsonError(res, 404, 'Deposit not found.');
  if (item.status !== 'pending') return sendJsonError(res, 409, 'Deposit is already processed.');
  const user = getUser(item.userId);
  if (!user) return sendJsonError(res, 404, 'Deposit user not found.');
  item.status = 'approved'; item.reviewedAt = now(); item.reviewedBy = req.adminId;
  user.balance += item.amount; save('users'); save('deposits');
  addTransaction(user.id, 'demo_deposit', item.amount, { depositId: item.id });
  audit(req.adminId, 'demo.deposit.approved', { depositId: item.id, userId: user.id });
  notifyUser(user.id, `Your demo deposit request (${item.amount}) was approved. No real funds were transferred.`);
  res.json({ ok: true, deposit: item, balance: user.balance });
});
app.post('/api/admin/deposits/:id/reject', (req, res) => {
  const item = db.deposits.find(x => x.id === req.params.id);
  if (!item) return sendJsonError(res, 404, 'Deposit not found.');
  if (item.status !== 'pending') return sendJsonError(res, 409, 'Deposit is already processed.');
  item.status = 'rejected'; item.reviewedAt = now(); item.reviewedBy = req.adminId;
  item.adminReason = String(req.body.reason || '').slice(0, 500);
  save('deposits'); audit(req.adminId, 'demo.deposit.rejected', { depositId: item.id });
  notifyUser(item.userId, 'Your demo deposit request was rejected.');
  res.json({ ok: true, deposit: item });
});

// Withdrawal management. Approval is a demo status change only; no payment is sent.
app.get('/api/admin/withdrawals', (req, res) => {
  let list = filterDate(db.withdrawals, req.query.from, req.query.to);
  if (req.query.status) list = list.filter(x => x.status === req.query.status);
  if (req.query.q) list = list.filter(x => x.userId.includes(String(req.query.q)));
  list.sort((a, b) => b.at.localeCompare(a.at)); res.json(paged(list, req));
});
app.post('/api/admin/withdrawals/:id/approve', (req, res) => {
  const item = db.withdrawals.find(x => x.id === req.params.id);
  if (!item) return sendJsonError(res, 404, 'Withdrawal not found.');
  if (item.status !== 'pending') return sendJsonError(res, 409, 'Withdrawal is already processed.');
  item.status = 'approved'; item.reviewedAt = now(); item.reviewedBy = req.adminId;
  item.paymentHash = String(req.body.paymentHash || 'DEMO-NOT-A-REAL-TRANSFER').slice(0, 200);
  save('withdrawals'); audit(req.adminId, 'demo.withdrawal.approved', { withdrawalId: item.id });
  notifyUser(item.userId, 'Your demo withdrawal request was marked approved. No real payment was sent.');
  res.json({ ok: true, withdrawal: item });
});
app.post('/api/admin/withdrawals/:id/reject', (req, res) => {
  const item = db.withdrawals.find(x => x.id === req.params.id);
  if (!item) return sendJsonError(res, 404, 'Withdrawal not found.');
  if (item.status !== 'pending') return sendJsonError(res, 409, 'Withdrawal is already processed.');
  const user = getUser(item.userId);
  if (user) { user.balance += item.amount; save('users'); addTransaction(user.id, 'demo_withdrawal_refund', item.amount, { withdrawalId: item.id }); }
  item.status = 'rejected'; item.reviewedAt = now(); item.reviewedBy = req.adminId;
  item.adminReason = String(req.body.reason || '').slice(0, 500);
  save('withdrawals'); audit(req.adminId, 'demo.withdrawal.rejected', { withdrawalId: item.id });
  notifyUser(item.userId, 'Your demo withdrawal request was rejected; the virtual balance was returned.');
  res.json({ ok: true, withdrawal: item, refunded: Boolean(user) });
});

// Trade settings and history.
app.get('/api/admin/trades', (req, res) => {
  let list = filterDate(db.trades, req.query.from, req.query.to);
  if (req.query.userId) list = list.filter(x => x.userId === String(req.query.userId));
  if (req.query.result) list = list.filter(x => x.result === req.query.result);
  if (req.query.pair) list = list.filter(x => x.pair === req.query.pair);
  list.sort((a, b) => b.at.localeCompare(a.at)); res.json(paged(list, req));
});
app.patch('/api/admin/trade-settings', (req, res) => {
  const allowed = ['tradingEnabled', 'tradeDuration', 'multiplier', 'minStake', 'maxStake', 'cancelEnabled', 'enabledPairs'];
  for (const key of allowed) if (key in req.body) db.config[key] = req.body[key];
  if (!Array.isArray(db.config.enabledPairs) || !db.config.enabledPairs.some(x => typeof x === 'string')) {
    return sendJsonError(res, 400, 'enabledPairs must be a non-empty array.');
  }
  if (num(db.config.tradeDuration) < 5 || num(db.config.multiplier) < 1 ||
      num(db.config.minStake) <= 0 || num(db.config.maxStake) < num(db.config.minStake)) {
    return sendJsonError(res, 400, 'Invalid trade settings.');
  }
  save('config'); audit(req.adminId, 'trade.settings_updated', req.body);
  res.json({ ok: true, config: db.config });
});

// Gift code management.
app.get('/api/admin/giftcodes', (_req, res) => res.json(db.giftCodes));
app.post('/api/admin/giftcodes', (req, res) => {
  const amount = num(req.body.amount);
  const maxUses = Math.max(1, Number(req.body.maxUses) || 1);
  const code = String(req.body.code || crypto.randomBytes(5).toString('hex').toUpperCase()).trim().toUpperCase();
  if (!/^[A-Z0-9_-]{4,32}$/.test(code) || !Number.isFinite(amount) || amount <= 0 ||
      db.giftCodes.some(x => x.code === code)) return sendJsonError(res, 400, 'Invalid or duplicate gift code.');
  const item = { id: id('gift'), code, amount, maxUses, redeemedBy: [],
    expiresAt: req.body.expiresAt || null, active: true, createdAt: now() };
  db.giftCodes.push(item); save('giftCodes'); audit(req.adminId, 'giftcode.created', { code, amount });
  res.status(201).json({ ok: true, giftCode: item });
});
app.patch('/api/admin/giftcodes/:id', (req, res) => {
  const item = db.giftCodes.find(x => x.id === req.params.id);
  if (!item) return sendJsonError(res, 404, 'Gift code not found.');
  if ('amount' in req.body && num(req.body.amount) > 0) item.amount = num(req.body.amount);
  if ('maxUses' in req.body && num(req.body.maxUses) >= item.redeemedBy.length) item.maxUses = num(req.body.maxUses);
  if ('expiresAt' in req.body) item.expiresAt = req.body.expiresAt || null;
  if (typeof req.body.active === 'boolean') item.active = req.body.active;
  save('giftCodes'); audit(req.adminId, 'giftcode.updated', { id: item.id });
  res.json({ ok: true, giftCode: item });
});
app.delete('/api/admin/giftcodes/:id', (req, res) => {
  const before = db.giftCodes.length;
  db.giftCodes = db.giftCodes.filter(x => x.id !== req.params.id);
  if (db.giftCodes.length === before) return sendJsonError(res, 404, 'Gift code not found.');
  save('giftCodes'); audit(req.adminId, 'giftcode.deleted', { id: req.params.id });
  res.json({ ok: true });
});
app.get('/api/admin/giftcodes/:id/redeems', (req, res) => {
  const item = db.giftCodes.find(x => x.id === req.params.id);
  if (!item) return sendJsonError(res, 404, 'Gift code not found.');
  res.json({ code: item.code, redeemers: item.redeemedBy || [] });
});

// Referral administration.
app.get('/api/admin/referrals', (req, res) => {
  let list = db.referrals;
  if (req.query.userId) list = list.filter(x => x.referrerId === String(req.query.userId) || x.inviteeId === String(req.query.userId));
  res.json(paged(list.slice().reverse(), req));
});
app.patch('/api/admin/referral-settings', (req, res) => {
  if (typeof req.body.referralEnabled === 'boolean') db.config.referralEnabled = req.body.referralEnabled;
  if ('referralRate' in req.body && num(req.body.referralRate) >= 0 && num(req.body.referralRate) <= 100) db.config.referralRate = num(req.body.referralRate);
  save('config'); audit(req.adminId, 'referral.settings_updated', req.body);
  res.json({ ok: true, referralEnabled: db.config.referralEnabled, referralRate: db.config.referralRate });
});

// Wallet / ledger search.
app.get('/api/admin/transactions', (req, res) => {
  let list = filterDate(db.transactions, req.query.from, req.query.to);
  if (req.query.userId) list = list.filter(x => x.userId === String(req.query.userId));
  if (req.query.type) list = list.filter(x => x.type === req.query.type);
  if (req.query.q) list = list.filter(x => x.id.includes(String(req.query.q)) || JSON.stringify(x.details).includes(String(req.query.q)));
  list.sort((a, b) => b.at.localeCompare(a.at)); res.json(paged(list, req));
});

// Bonus settings/history.
app.get('/api/admin/bonuses', (req, res) => {
  let list = db.bonuses;
  if (req.query.userId) list = list.filter(x => x.userId === String(req.query.userId));
  res.json(paged(list.slice().reverse(), req));
});
app.patch('/api/admin/bonus-settings', (req, res) => {
  if (typeof req.body.welcomeBonusEnabled === 'boolean') db.config.welcomeBonusEnabled = req.body.welcomeBonusEnabled;
  if ('welcomeBonusAmount' in req.body && num(req.body.welcomeBonusAmount) >= 0) db.config.welcomeBonusAmount = num(req.body.welcomeBonusAmount);
  if ('turnoverRequirement' in req.body && num(req.body.turnoverRequirement) >= 0) db.config.turnoverRequirement = num(req.body.turnoverRequirement);
  save('config'); audit(req.adminId, 'bonus.settings_updated', req.body);
  res.json({ ok: true, config: db.config });
});

// App settings (only allowlisted keys; demo mode cannot be disabled).
app.patch('/api/admin/settings', (req, res) => {
  const allowed = ['appName', 'maintenanceEnabled', 'maintenanceMessage', 'depositEnabled',
    'withdrawEnabled', 'minDeposit', 'minWithdraw', 'maxWithdraw', 'networkFee',
    'supportUrl', 'communityUrl', 'botUsername', 'announcementEnabled',
    'announcementMessage', 'depositWalletAddress'];
  for (const key of allowed) if (key in req.body) db.config[key] = req.body[key];
  db.config.demoMode = true;
  save('config'); audit(req.adminId, 'app.settings_updated', Object.keys(req.body));
  res.json({ ok: true, config: db.config });
});

// Announcement CRUD + broadcast to Telegram users.
app.get('/api/admin/announcements', (_req, res) => res.json(db.announcements.slice().reverse()));
app.post('/api/admin/announcements', (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message) return sendJsonError(res, 400, 'Announcement message is required.');
  const item = { id: id('ann'), title: String(req.body.title || '').slice(0, 120),
    message: message.slice(0, 4000), active: req.body.active !== false,
    popup: Boolean(req.body.popup), important: Boolean(req.body.important), createdAt: now() };
  db.announcements.push(item); save('announcements'); audit(req.adminId, 'announcement.created', { id: item.id });
  res.status(201).json({ ok: true, announcement: item });
});
app.patch('/api/admin/announcements/:id', (req, res) => {
  const item = db.announcements.find(x => x.id === req.params.id);
  if (!item) return sendJsonError(res, 404, 'Announcement not found.');
  for (const key of ['title', 'message', 'active', 'popup', 'important']) if (key in req.body) item[key] = req.body[key];
  save('announcements'); audit(req.adminId, 'announcement.updated', { id: item.id });
  res.json({ ok: true, announcement: item });
});
app.delete('/api/admin/announcements/:id', (req, res) => {
  const old = db.announcements.length;
  db.announcements = db.announcements.filter(x => x.id !== req.params.id);
  if (old === db.announcements.length) return sendJsonError(res, 404, 'Announcement not found.');
  save('announcements'); audit(req.adminId, 'announcement.deleted', { id: req.params.id });
  res.json({ ok: true });
});
app.get('/api/announcements', (_req, res) => res.json(db.announcements.filter(x => x.active && db.config.announcementEnabled)));

// Reports and CSV export.
app.get('/api/admin/reports/export.csv', (req, res) => {
  const type = String(req.query.type || 'transactions');
  const map = { users: db.users ? Object.values(db.users) : [], deposits: db.deposits,
    withdrawals: db.withdrawals, trades: db.trades, referrals: db.referrals,
    giftcodes: db.giftCodes, transactions: db.transactions };
  if (!map[type]) return sendJsonError(res, 400, 'Unsupported export type.');
  const rows = map[type];
  const keys = [...new Set(rows.flatMap(x => Object.keys(x)))];
  const output = [keys.map(csvCell).join(','), ...rows.map(row => keys.map(k =>
    csvCell(typeof row[k] === 'object' ? JSON.stringify(row[k]) : row[k])).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${type}-demo-report.csv"`);
  res.send('\uFEFF' + output);
});
app.get('/api/admin/audit', (req, res) => res.json(paged(db.audit.slice().reverse(), req)));

// Admin overview and Telegram admin notifications.
app.get('/api/admin/config', (_req, res) => res.json({ ...db.config, demoMode: true }));
let bot;
function notifyAdmins(message) {
  if (!bot) return;
  for (const adminId of ADMIN_IDS) bot.telegram.sendMessage(adminId, message).catch(() => {});
}
function notifyUser(userId, message) {
  if (bot) bot.telegram.sendMessage(String(userId), message).catch(() => {});
}

if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
  const isAdmin = ctx => ADMIN_IDS.has(String(ctx.from?.id || ''));
  const adminOnly = async (ctx, next) => {
    if (!isAdmin(ctx)) { await ctx.reply('Access denied.'); return; }
    return next();
  };
  const panelKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.callback('Dashboard', 'adm_dashboard'), Markup.button.callback('Users', 'adm_users')],
    [Markup.button.callback('Pending Deposits', 'adm_deposits'), Markup.button.callback('Withdrawals', 'adm_withdrawals')],
    [Markup.button.callback('Trades', 'adm_trades'), Markup.button.callback('Gift Codes', 'adm_gifts')],
    [Markup.button.callback('App Controls', 'adm_controls'), Markup.button.callback('Help', 'adm_help')]
  ]);
  bot.start(async ctx => {
    if (!isAdmin(ctx)) return ctx.reply('TreaderBooom Demo Bot. This account is not an administrator.');
    return ctx.reply('TreaderBooom Demo Admin Panel\nAll balances and requests are simulated.', panelKeyboard());
  });
  bot.command('panel', adminOnly, ctx => ctx.reply('Demo Admin Panel', panelKeyboard()));
  bot.command('status', adminOnly, ctx => {
    const users = Object.keys(db.users).length;
    const pending = db.deposits.filter(x => x.status === 'pending').length;
    const wd = db.withdrawals.filter(x => x.status === 'pending').length;
    return ctx.reply(`Demo status\nUsers: ${users}\nPending deposits: ${pending}\nPending withdrawals: ${wd}`);
  });
  bot.command('help', adminOnly, ctx => ctx.reply('/panel — admin menu\n/status — summary\n/broadcast Your message — announcement'));
  bot.command('broadcast', adminOnly, async ctx => {
    const message = ctx.message.text.replace(/^\/broadcast(?:@\w+)?\s*/, '').trim();
    if (!message) return ctx.reply('Usage: /broadcast Your announcement');
    let sent = 0, failed = 0;
    for (const user of Object.values(db.users)) {
      if (user.blocked || user.active === false) continue;
      try { await bot.telegram.sendMessage(user.id, `📢 ${message}`); sent++; }
      catch { failed++; }
    }
    audit(ctx.from.id, 'announcement.telegram_broadcast', { sent, failed });
    ctx.reply(`Broadcast finished. Sent: ${sent}; failed: ${failed}.`);
  });
  bot.action('adm_dashboard', adminOnly, async ctx => {
    await ctx.answerCbQuery();
    const d = {
      users: Object.keys(db.users).length,
      online: Object.values(db.users).filter(isOnline).length,
      deposits: db.deposits.filter(x => x.status === 'pending').length,
      withdrawals: db.withdrawals.filter(x => x.status === 'pending').length
    };
    return ctx.editMessageText(`DEMO Dashboard\nUsers: ${d.users}\nOnline: ${d.online}\nPending deposits: ${d.deposits}\nPending withdrawals: ${d.withdrawals}`, panelKeyboard());
  });
  bot.action('adm_users', adminOnly, async ctx => {
    await ctx.answerCbQuery();
    const list = Object.values(db.users).slice(-10).reverse();
    const body = list.length ? list.map(u => `${u.firstName || 'User'} — ${u.id} — ${u.balance} demo USDT`).join('\n') : 'No users.';
    return ctx.editMessageText(`Recent users\n\n${body}`, panelKeyboard());
  });
  bot.action('adm_deposits', adminOnly, async ctx => {
    await ctx.answerCbQuery();
    const list = db.deposits.filter(x => x.status === 'pending').slice(0, 5);
    const body = list.length ? list.map(x => `${x.id}\nUser: ${x.userId} | ${x.amount} demo USDT`).join('\n\n') : 'No pending demo deposits.';
    return ctx.editMessageText(body, panelKeyboard());
  });
  bot.action('adm_withdrawals', adminOnly, async ctx => {
    await ctx.answerCbQuery();
    const list = db.withdrawals.filter(x => x.status === 'pending').slice(0, 5);
    const body = list.length ? list.map(x => `${x.id}\nUser: ${x.userId} | ${x.amount} demo USDT`).join('\n\n') : 'No pending demo withdrawals.';
    return ctx.editMessageText(body, panelKeyboard());
  });
  bot.action('adm_trades', adminOnly, async ctx => {
    await ctx.answerCbQuery();
    return ctx.editMessageText(`Total demo trades: ${db.trades.length}`, panelKeyboard());
  });
  bot.action('adm_gifts', adminOnly, async ctx => {
    await ctx.answerCbQuery();
    return ctx.editMessageText(`Gift codes: ${db.giftCodes.length}\nManage full list through /api/admin/giftcodes.`, panelKeyboard());
  });
  bot.action('adm_controls', adminOnly, async ctx => {
    await ctx.answerCbQuery();
    return ctx.editMessageText(`Trading: ${db.config.tradingEnabled ? 'ON' : 'OFF'}\nMaintenance: ${db.config.maintenanceEnabled ? 'ON' : 'OFF'}\nDemo mode: ON`, panelKeyboard());
  });
  bot.action('adm_help', adminOnly, async ctx => {
    await ctx.answerCbQuery();
    return ctx.editMessageText('Use the authenticated /api/admin/* endpoints for full management. This bot is an overview interface.', panelKeyboard());
  });
  bot.launch().then(() => console.log('Telegram admin bot started.')).catch(err => console.error('Bot launch failed:', err.message));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'Internal server error.' });
});
app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));

const server = app.listen(PORT, () => console.log(`Demo server listening on port ${PORT}`));
function shutdown() {
  server.close(() => process.exit(0));
  if (bot) bot.stop('SIGTERM');
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
