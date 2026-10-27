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
function saveConfig() { writeJson(CONFIG_FILE, config); }
function saveUsers() { writeJson(USERS_FILE, users); }
function saveEvents() { writeJson(EVENTS_FILE, events.slice(-5000)); }

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
  users[id] = { id: u.id, firstName: u.first_name || '', username: u.username || '', lastSeen: new Date().toISOString(), blocked: users[id]?.blocked || false };
  saveUsers();
  if (users[id].blocked) return res.status(403).json({ error: 'This account is blocked.' });
  res.json({ user: { id: u.id, first_name: u.first_name || '', username: u.username || '' }, config: { appName: config.appName } });
});
app.post('/api/events', sessionMiddleware, (req, res) => {
  const id = String(req.telegramUser.id);
  if (users[id]?.blocked) return res.status(403).json({ error: 'Account blocked.' });
  const type = String(req.body?.type || 'unknown').slice(0, 60);
  const details = req.body?.details && typeof req.body.details === 'object' ? req.body.details : {};
  events.push({ id, type, details, at: new Date().toISOString() });
  saveEvents();
  res.json({ ok: true });
});

let bot;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
  const isAdmin = ctx => ADMIN_IDS.has(String(ctx.from?.id || ''));
  // Protect callback buttons too, including forwarded/copied admin messages.
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
    [Markup.button.callback('Trade settings', 'trade_settings'), Markup.button.callback('Messages', 'messages')],
    [Markup.button.callback('Users', 'users'), Markup.button.callback('Recent events', 'events')],
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
    'Admin commands:\n/panel — open control panel\n/status — app status\n/pause — pause new demo trades\n/resume — resume demo trades\n/duration 60 — set trade duration in seconds\n/multiplier 1.8 — set demo payout multiplier\n/broadcast Your message — send announcement to known Mini App users\n\nBot token belongs in .env, never in frontend HTML.'
  ));
  bot.command('status', adminOnly, ctx => ctx.reply(statusText()));
  bot.command('pause', adminOnly, async ctx => { config.tradingEnabled = false; saveConfig(); await ctx.reply('New trades paused.', mainKeyboard()); });
  bot.command('resume', adminOnly, async ctx => { config.tradingEnabled = true; saveConfig(); await ctx.reply('New trades enabled.', mainKeyboard()); });
  bot.command('duration', adminOnly, async ctx => {
    const n = Number(ctx.message.text.split(/\s+/)[1]);
    if (!Number.isInteger(n) || n < 5 || n > 3600) return ctx.reply('Use /duration 60 (5–3600 seconds).');
    config.tradeDuration = n; saveConfig(); ctx.reply(`Trade duration set to ${n} seconds.`);
  });
  bot.command('multiplier', adminOnly, async ctx => {
    const n = Number(ctx.message.text.split(/\s+/)[1]);
    if (!Number.isFinite(n) || n < 1 || n > 10) return ctx.reply('Use /multiplier 1.8 (allowed demo range 1–10).');
    config.multiplier = n; saveConfig(); ctx.reply(`Demo multiplier set to x${n}.`);
  });
  bot.command('broadcast', adminOnly, async ctx => {
    const message = ctx.message.text.replace(/^\/broadcast(?:@\w+)?\s*/, '').trim();
    if (!message) return ctx.reply('Usage: /broadcast Your announcement text');
    let sent = 0, failed = 0;
    for (const id of Object.keys(users)) {
      if (users[id].blocked) continue;
      try { await bot.telegram.sendMessage(id, `TreaderBooom announcement\n\n${message}`); sent++; }
      catch { failed++; }
    }
    ctx.reply(`Broadcast finished. Sent: ${sent}; failed: ${failed}.`);
  });

  function statusText() {
    return `TreaderBooom status\nTrading: ${config.tradingEnabled ? 'ENABLED' : 'PAUSED'}\nDuration: ${config.tradeDuration}s\nDemo multiplier: x${config.multiplier}\nCancel enabled: ${config.cancelEnabled ? 'Yes' : 'No'}\nRegistered Telegram users: ${Object.keys(users).length}\nRecorded events: ${events.length}`;
  }
  bot.action('dashboard', async ctx => { await ctx.answerCbQuery(); await ctx.editMessageText(statusText(), mainKeyboard()); });
  bot.action('controls', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('App controls\nChoose a setting:', Markup.inlineKeyboard([
      [Markup.button.callback(config.tradingEnabled ? 'Pause new trades' : 'Resume new trades', 'toggle_trading')],
      [Markup.button.callback(`Trade cancellation: ${config.cancelEnabled ? 'ON' : 'OFF'}`, 'toggle_cancel')],
      [Markup.button.callback(`Announcements: ${config.announcementsEnabled ? 'ON' : 'OFF'}`, 'toggle_announcements')],
      [Markup.button.callback('Back to panel', 'back')]
    ]));
  });
  bot.action('toggle_trading', async ctx => { config.tradingEnabled = !config.tradingEnabled; saveConfig(); await ctx.answerCbQuery(config.tradingEnabled ? 'Trading enabled' : 'Trading paused'); await ctx.editMessageText(statusText(), mainKeyboard()); });
  bot.action('toggle_cancel', async ctx => { config.cancelEnabled = !config.cancelEnabled; saveConfig(); await ctx.answerCbQuery('Updated'); await ctx.editMessageText(`Trade cancellation is now ${config.cancelEnabled ? 'ON' : 'OFF'}.`, Markup.inlineKeyboard([[Markup.button.callback('Back to controls', 'controls')],[Markup.button.callback('Main panel', 'back')]])); });
  bot.action('toggle_announcements', async ctx => { config.announcementsEnabled = !config.announcementsEnabled; saveConfig(); await ctx.answerCbQuery('Updated'); await ctx.editMessageText(`Announcements are now ${config.announcementsEnabled ? 'ON' : 'OFF'}.`, mainKeyboard()); });
  bot.action('trade_settings', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Trade settings\nDuration: ${config.tradeDuration}s\nDemo multiplier: x${config.multiplier}\nMinimum stake: ${config.minStake}\nMaximum stake: ${config.maxStakePercent}% of displayed balance\n\nUse commands:\n/duration 60\n/multiplier 1.8`, Markup.inlineKeyboard([[Markup.button.callback('Back to panel', 'back')]]));
  });
  bot.action('messages', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Result message templates (current defaults)\n\nWIN: ${config.resultWinMessage}\n\nLOSS: ${config.resultLossMessage}\n\nCANCEL: ${config.resultCancelMessage}\n\nTo customize safely, edit data/config.json and restart the service.`, Markup.inlineKeyboard([[Markup.button.callback('Back to panel', 'back')]]));
  });
  bot.action('users', async ctx => {
    await ctx.answerCbQuery();
    const list = Object.values(users).slice(-20).reverse();
    const body = list.length ? list.map(u => `${u.blocked ? '[BLOCKED] ' : ''}${u.firstName || 'User'}${u.username ? ' @'+u.username : ''} — ID ${u.id}`).join('\n') : 'No users have opened the Mini App yet.';
    await ctx.editMessageText(`Users (${Object.keys(users).length} total; showing latest 20)\n\n${body}`, Markup.inlineKeyboard([[Markup.button.callback('Refresh', 'users')],[Markup.button.callback('Back to panel', 'back')]]));
  });
  bot.action('events', async ctx => {
    await ctx.answerCbQuery();
    const recent = events.slice(-15).reverse();
    const body = recent.length ? recent.map(e => `${e.at} | user ${e.id} | ${e.type}`).join('\n') : 'No events recorded yet.';
    await ctx.editMessageText(`Recent app events\n\n${body}`, Markup.inlineKeyboard([[Markup.button.callback('Refresh', 'events')],[Markup.button.callback('Back to panel', 'back')]]));
  });
  bot.action('broadcast_help', async ctx => { await ctx.answerCbQuery(); await ctx.reply('Send an announcement using:\n/broadcast Your announcement text\n\nOnly users who have opened the Mini App and whose IDs were recorded can receive it.'); });
  bot.action('help', async ctx => { await ctx.answerCbQuery(); await ctx.reply('/panel /status /pause /resume /duration 60 /multiplier 1.8 /broadcast Your message'); });
  bot.action('back', async ctx => { await ctx.answerCbQuery(); await ctx.editMessageText('TreaderBooom Control Center\nChoose a section below.', mainKeyboard()); });
  bot.catch(err => console.error('Telegram bot error:', err.message));
  bot.launch().then(() => console.log('Telegram admin bot started.')).catch(err => console.error('Bot launch failed:', err.message));
} else {
  console.warn('TELEGRAM_BOT_TOKEN is missing. Admin bot is disabled until configured in .env');
}

app.listen(PORT, () => console.log(`TreaderBooom server listening on port ${PORT}`));
process.once('SIGINT', () => { if (bot) bot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => { if (bot) bot.stop('SIGTERM'); process.exit(0); });
