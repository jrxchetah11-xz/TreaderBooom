require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(__dirname));

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_IDS = new Set((process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const DEPOSITS_FILE = path.join(DATA_DIR, 'deposits.json');
const WITHDRAWALS_FILE = path.join(DATA_DIR, 'withdrawals.json');
const GIFTCODES_FILE = path.join(DATA_DIR, 'giftcodes.json');

const defaults = {
  appName: 'TreaderBooom',
  tradingEnabled: true,
  tradeDuration: 60,
  multiplier: 1.8,
  cancelEnabled: true,
  minStake: 0.001,
  maxStakePercent: 10,
  maintenanceMessage: 'Trading is temporarily paused. Please try again later.',
  announcementsEnabled: true,
  supportUrl: 'https://t.me/',
  resultWinMessage: 'WIN CONFIRMED — your demo trade was successful.',
  resultLossMessage: 'TRADE LOST — your demo trade did not go your way.',
  resultCancelMessage: 'TRADE CANCELLED — your demo stake was returned.'
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }

let config = { ...defaults, ...readJson(CONFIG_FILE, {}) };
let users = readJson(USERS_FILE, {});
let events = readJson(EVENTS_FILE, []);
let deposits = readJson(DEPOSITS_FILE, []);
let withdrawals = readJson(WITHDRAWALS_FILE, []);
let giftCodes = readJson(GIFTCODES_FILE, []);

function saveConfig() { writeJson(CONFIG_FILE, config); }
function saveUsers() { writeJson(USERS_FILE, users); }
function saveEvents() { writeJson(EVENTS_FILE, events.slice(-5000)); }
function saveDeposits() { writeJson(DEPOSITS_FILE, deposits); }
function saveWithdrawals() { writeJson(WITHDRAWALS_FILE, withdrawals); }
function saveGiftCodes() { writeJson(GIFTCODES_FILE, giftCodes); }

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData || typeof initData !== 'string') return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const checkString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || (Date.now() / 1000 - authDate) > 86400) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return null;
    return user;
  } catch { return null; }
}

function sessionMiddleware(req, res, next) {
  const user = verifyTelegramInitData(req.body?.initData || req.headers['x-telegram-init-data']);
  if (!user) return res.status(401).json({ error: 'Valid Telegram Mini App session required.' });
  req.telegramUser = user;
  next();
}

app.get('/api/health', (_req, res) => res.json({ ok: true, app: config.appName }));
app.get('/api/config', (_req, res) => {
  const { appName, tradingEnabled, tradeDuration, multiplier, cancelEnabled, minStake, maxStakePercent, maintenanceMessage, supportUrl } = config;
  res.json({ appName, tradingEnabled, tradeDuration, multiplier, cancelEnabled, minStake, maxStakePercent, maintenanceMessage, supportUrl });
});

app.post('/api/session', sessionMiddleware, (req, res) => {
  const u = req.telegramUser;
  const id = String(u.id);
  if (!users[id]) {
    users[id] = { id: u.id, firstName: u.first_name || '', username: u.username || '', balance: 0, blocked: false, createdAt: new Date().toISOString() };
  }
  users[id].lastSeen = new Date().toISOString();
  saveUsers();
  if (users[id].blocked) return res.status(403).json({ error: 'This account is blocked.' });
  res.json({ user: { id: u.id, first_name: u.first_name || '', username: u.username || '', balance: users[id].balance }, config: { appName: config.appName } });
});

// Deposit Submit Endpoint -> Goes to Admin Pending Queue
app.post('/api/deposit/submit', sessionMiddleware, (req, res) => {
  const id = String(req.telegramUser.id);
  if (users[id]?.blocked) return res.status(403).json({ error: 'Account blocked.' });
  const { amount, txid } = req.body;
  if (!amount || !txid) return res.status(400).json({ error: 'Amount and TxID are required.' });

  const depositItem = {
    id: 'dep_' + Date.now(),
    userId: id,
    userName: users[id]?.firstName || 'User',
    amount: Number(amount),
    txid: String(txid),
    status: 'pending',
    at: new Date().toISOString()
  };
  deposits.push(depositItem);
  saveDeposits();

  // Notify Admins via Telegram Bot if available
  if (bot) {
    for (const adminId of ADMIN_IDS) {
      bot.telegram.sendMessage(adminId, 
        `🔔 **New Deposit Request!**\n\nUser: ${depositItem.userName} (ID: \`${id}\`)\nAmount: ${depositItem.amount} USDT\nTxID: \`${depositItem.txid}\``,
        Markup.inlineKeyboard([
          [Markup.button.callback(`✅ Approve`, `approve_dep_${depositItem.id}`), Markup.button.callback(`❌ Reject`, `reject_dep_${depositItem.id}`)]
        ])
      ).catch(() => {});
    }
  }

  res.json({ ok: true, message: 'Deposit request submitted successfully to admin.' });
});

// Get User History Endpoints
app.get('/api/history', sessionMiddleware, (req, res) => {
  const id = String(req.telegramUser.id);
  res.json({
    deposits: deposits.filter(d => d.userId === id),
    withdrawals: withdrawals.filter(w => w.userId === id)
  });
});

let bot;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
  const isAdmin = ctx => ADMIN_IDS.has(String(ctx.from?.id || ''));

  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery && !isAdmin(ctx)) {
      try { await ctx.answerCbQuery('Access denied.'); } catch {}
      return;
    }
    return next();
  });

  const adminOnly = async (ctx, next) => {
    if (!isAdmin(ctx)) { await ctx.reply('Access denied. This bot is restricted to configured administrators.'); return; }
    return next();
  };

  const mainKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.callback('Dashboard', 'dashboard'), Markup.button.callback('App controls', 'controls')],
    [Markup.button.callback('Pending Deposits', 'pending_deposits'), Markup.button.callback('Withdrawals', 'withdrawals_list')],
    [Markup.button.callback('User Management', 'users_mgmt'), Markup.button.callback('Gift Codes', 'gift_codes_menu')],
    [Markup.button.callback('Broadcast', 'broadcast_help'), Markup.button.callback('Help', 'help')]
  ]);

  bot.start(async ctx => {
    if (!isAdmin(ctx)) {
      await ctx.reply('TreaderBooom Admin Bot. This account is not on the administrator allowlist.');
      return;
    }
    await ctx.reply('TreaderBooom Control Center\nChoose a section below.', mainKeyboard());
  });

  bot.command('panel', adminOnly, ctx => ctx.reply('TreaderBooom Control Center', mainKeyboard()));
  bot.command('help', adminOnly, ctx => ctx.reply(
    'Admin commands:\n/panel — open control panel\n/status — app status\n/broadcast Your message — send announcement'
  ));
  bot.command('status', adminOnly, ctx => ctx.reply(statusText()));

  // Broadcast Command
  bot.command('broadcast', adminOnly, async ctx => {
    const message = ctx.message.text.replace(/^\/broadcast(?:@\w+)?\s*/, '').trim();
    if (!message) return ctx.reply('Usage: /broadcast Your announcement text');
    let sent = 0, failed = 0;
    for (const id of Object.keys(users)) {
      if (users[id].blocked) continue;
      try { await bot.telegram.sendMessage(id, `📢 **Announcement**\n\n${message}`); sent++; }
      catch { failed++; }
    }
    ctx.reply(`Broadcast finished. Sent: ${sent}; failed: ${failed}.`);
  });

  function statusText() {
    return `📊 **TreaderBooom Status**\nTrading: ${config.tradingEnabled ? 'ENABLED' : 'PAUSED'}\nRegistered Users: ${Object.keys(users).length}\nPending Deposits: ${deposits.filter(d => d.status === 'pending').length}`;
  }

  bot.action('dashboard', async ctx => { await ctx.answerCbQuery(); await ctx.editMessageText(statusText(), mainKeyboard()); });
  
  // Pending Deposits Management in Telegram Bot
  bot.action('pending_deposits', async ctx => {
    await ctx.answerCbQuery();
    const pending = deposits.filter(d => d.status === 'pending');
    if (!pending.length) {
      return ctx.editMessageText('No pending deposits found.', Markup.inlineKeyboard([[Markup.button.callback('Back to panel', 'back')]]));
    }
    const item = pending[0];
    await ctx.editMessageText(
      `📥 **Deposit Request**\n\nUser: ${item.userName} (\`${item.userId}\`)\nAmount: **${item.amount} USDT**\nTxID: \`${item.txid}\`\nDate: ${item.at}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Approve Deposit', `approve_dep_${item.id}`), Markup.button.callback('❌ Reject Deposit', `reject_dep_${item.id}`)],
        [Markup.button.callback('Back to panel', 'back')]
      ])
    );
  });

  // Approve Deposit Action
  bot.action(/^approve_dep_(.+)$/, async ctx => {
    await ctx.answerCbQuery('Processing approval...');
    const depId = ctx.match[1];
    const dep = deposits.find(d => d.id === depId);
    if (!dep || dep.status !== 'approved') {
      if (dep) {
        dep.status = 'approved';
        if (users[dep.userId]) {
          users[dep.userId].balance = (users[dep.userId].balance || 0) + dep.amount;
          saveUsers();
        }
        saveDeposits();
        try { await bot.telegram.sendMessage(dep.userId, `✅ Your deposit of ${dep.amount} USDT has been approved and added to your balance!`); } catch {}
      }
    }
    await ctx.editMessageText('Deposit approved successfully!', Markup.inlineKeyboard([[Markup.button.callback('Back to panel', 'back')]]));
  });

  // Reject Deposit Action
  bot.action(/^reject_dep_(.+)$/, async ctx => {
    await ctx.answerCbQuery('Rejecting...');
    const depId = ctx.match[1];
    const dep = deposits.find(d => d.id === depId);
    if (dep) {
      dep.status = 'rejected';
      saveDeposits();
      try { await bot.telegram.sendMessage(dep.userId, `❌ Your deposit request of ${dep.amount} USDT was rejected by admin.`); } catch {}
    }
    await ctx.editMessageText('Deposit rejected.', Markup.inlineKeyboard([[Markup.button.callback('Back to panel', 'back')]]));
  });

  // User Management Menu
  bot.action('users_mgmt', async ctx => {
    await ctx.answerCbQuery();
    const totalUsers = Object.keys(users).length;
    await ctx.editMessageText(
      `👥 **User Management**\nTotal Registered Users: ${totalUsers}\n\nUse user controls to view or manage status.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('View Recent Users', 'list_users')],
        [Markup.button.callback('Back to panel', 'back')]
      ])
    );
  });

  bot.action('list_users', async ctx => {
    await ctx.answerCbQuery();
    const list = Object.values(users).slice(-10).reverse();
    const body = list.length ? list.map(u => `${u.blocked ? '[BLOCKED] ' : ''}${u.firstName} (ID: ${u.id}) - Bal: ${u.balance || 0} USDT`).join('\n') : 'No users found.';
    await ctx.editMessageText(`Recent Users:\n\n${body}`, Markup.inlineKeyboard([[Markup.button.callback('Back', 'users_mgmt')]]));
  });

  // Gift Codes Management Menu
  bot.action('gift_codes_menu', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `🎁 **Gift Codes Management**\nActive Gift Codes: ${giftCodes.length}\n\nTo generate a gift code via command or manage them, use your custom admin logic.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('List Gift Codes', 'list_gift_codes')],
        [Markup.button.callback('Back to panel', 'back')]
      ])
    );
  });

  bot.action('list_gift_codes', async ctx => {
    await ctx.answerCbQuery();
    const body = giftCodes.length ? giftCodes.map(g => `Code: \`${g.code}\` — ${g.amount} USDT`).join('\n') : 'No gift codes created yet.';
    await ctx.editMessageText(`Gift Codes:\n\n${body}`, Markup.inlineKeyboard([[Markup.button.callback('Back', 'gift_codes_menu')]]));
  });

  bot.action('withdrawals_list', async ctx => {
    await ctx.answerCbQuery();
    const body = withdrawals.length ? withdrawals.slice(-10).map(w => `User ${w.userId}: ${w.amount} USDT [${w.status}]`).join('\n') : 'No withdrawal records.';
    await ctx.editMessageText(`Withdrawal History:\n\n${body}`, Markup.inlineKeyboard([[Markup.button.callback('Back to panel', 'back')]]));
  });

  bot.action('controls', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('App controls:', Markup.inlineKeyboard([
      [Markup.button.callback(config.tradingEnabled ? 'Pause trading' : 'Resume trading', 'toggle_trading')],
      [Markup.button.callback('Back to panel', 'back')]
    ]));
  });

  bot.action('toggle_trading', async ctx => { 
    config.tradingEnabled = !config.tradingEnabled; 
    saveConfig(); 
    await ctx.answerCbQuery('Updated'); 
    await ctx.editMessageText(statusText(), mainKeyboard()); 
  });

  bot.action('broadcast_help', async ctx => { 
    await ctx.answerCbQuery(); 
    await ctx.reply('Send broadcast using command:\n/broadcast Your message text'); 
  });

  bot.action('back', async ctx => { await ctx.answerCbQuery(); await ctx.editMessageText('TreaderBooom Control Center', mainKeyboard()); });
  
  bot.launch().then(() => console.log('Telegram admin bot started with full management features.')).catch(console.error);
}

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
