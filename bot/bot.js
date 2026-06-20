'use strict';

/**
 * Telegram bot bridge for pi coding agent.
 *
 * Pi is launched in --mode rpc which streams JSONL events over stdout.
 * One pi process is kept alive per Telegram chat (session).
 *
 * Key env vars:
 *   TELEGRAM_BOT_TOKEN   — required
 *   ALLOWED_CHAT_IDS     — comma-separated chat IDs; empty = allow all (dev only)
 *   ANTHROPIC_API_KEY    — forwarded to pi process
 *   PI_PROVIDER          — e.g. "anthropic" (default)
 *   PI_MODEL             — e.g. "claude-sonnet-4-20250514" (optional)
 *   WORKSPACE            — base dir for repos (default /workspace)
 */

const { Telegraf } = require('telegraf');
const { spawn, execSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

const WORKSPACE = process.env.WORKSPACE || '/workspace';
const PI_PROVIDER = process.env.PI_PROVIDER || 'anthropic';
const PI_MODEL = process.env.PI_MODEL || '';

// Telegram message length limit
const TG_MAX_LEN = 4000;

// ── Bot ───────────────────────────────────────────────────────────────────────

const bot = new Telegraf(BOT_TOKEN);

/** @type {Map<number, PiSession>} */
const sessions = new Map();

function isAllowed(chatId) {
  if (ALLOWED_CHAT_IDS.length === 0) return true;
  return ALLOWED_CHAT_IDS.includes(chatId);
}

// ── PiSession ─────────────────────────────────────────────────────────────────

/**
 * Wraps a single `pi --mode rpc` process.
 * Handles JSONL event parsing and routes events back to Telegram.
 */
class PiSession {
  /**
   * @param {number} chatId
   * @param {string} [cwd]
   */
  constructor(chatId, cwd) {
    this.chatId = chatId;
    this.cwd = cwd || WORKSPACE;
    this.isStreaming = false;

    // Accumulate text_delta events until agent_end
    this._pendingText = '';

    // JSONL framing state
    this._decoder = new StringDecoder('utf8');
    this._buffer = '';

    const args = ['--mode', 'rpc'];
    if (PI_PROVIDER) args.push('--provider', PI_PROVIDER);
    if (PI_MODEL) args.push('--model', PI_MODEL);

    this._proc = spawn('pi', args, {
      cwd: this.cwd,
      env: process.env,
    });

    // Use manual buffer splitting — Node readline also splits on U+2028/U+2029
    // which breaks JSONL framing per pi's RPC spec.
    this._proc.stdout.on('data', (chunk) => this._onData(chunk));

    this._proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) this._tg(`⚠️ ${text}`);
    });

    this._proc.on('close', (code) => {
      sessions.delete(this.chatId);
      this._tg(`🔴 Session ended (exit ${code})`);
    });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _onData(chunk) {
    this._buffer += this._decoder.write(chunk);
    while (true) {
      const idx = this._buffer.indexOf('\n');
      if (idx === -1) break;
      let line = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      try {
        this._handleEvent(JSON.parse(line));
      } catch (_) {
        // ignore malformed lines
      }
    }
  }

  _handleEvent(event) {
    switch (event.type) {
      case 'agent_start':
        this.isStreaming = true;
        this._pendingText = '';
        break;

      case 'message_update': {
        const mev = event.assistantMessageEvent;
        if (mev?.type === 'text_delta') {
          this._pendingText += mev.delta;
        }
        break;
      }

      case 'agent_end':
        this.isStreaming = false;
        if (this._pendingText.trim()) {
          this._sendChunked(this._pendingText.trim());
          this._pendingText = '';
        }
        break;

      case 'tool_execution_start':
        // Show the user what command pi is running
        if (event.toolName === 'bash') {
          const cmd = event.args?.command ?? '...';
          const preview = cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd;
          this._tg(`🔧 \`${preview}\``);
        }
        break;

      // ── Extension UI dialogs ──────────────────────────────────────────────
      // Pi may ask for confirmation or input while running.
      // We auto-accept for now; improve later by forwarding to Telegram.
      case 'extension_ui_request': {
        const req = event;
        if (req.method === 'confirm') {
          this._write({ type: 'extension_ui_response', id: req.id, confirmed: true });
          this._tg(`❓ Auto-confirmed: _${req.title ?? 'Confirm?'}_`);
        } else if (req.method === 'select') {
          const choice = req.options?.[0];
          this._write({ type: 'extension_ui_response', id: req.id, value: choice });
        } else if (req.method === 'input') {
          this._write({ type: 'extension_ui_response', id: req.id, value: '' });
        }
        // Fire-and-forget methods (notify, setStatus, …) need no response
        break;
      }

      default:
        break;
    }
  }

  _write(obj) {
    try {
      this._proc.stdin.write(JSON.stringify(obj) + '\n');
    } catch (_) {}
  }

  /** Send a Telegram message, try Markdown first then plain text fallback. */
  _tg(text) {
    bot.telegram
      .sendMessage(this.chatId, text, { parse_mode: 'Markdown' })
      .catch(() => bot.telegram.sendMessage(this.chatId, text).catch(() => {}));
  }

  /** Split long responses and send each chunk. */
  _sendChunked(text) {
    const chunks = [];
    let remaining = text;
    while (remaining.length > TG_MAX_LEN) {
      chunks.push(remaining.slice(0, TG_MAX_LEN));
      remaining = remaining.slice(TG_MAX_LEN);
    }
    if (remaining) chunks.push(remaining);

    (async () => {
      for (const chunk of chunks) {
        await bot.telegram
          .sendMessage(this.chatId, chunk, { parse_mode: 'Markdown' })
          .catch(() => bot.telegram.sendMessage(this.chatId, chunk).catch(() => {}));
      }
    })();
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  /** Send a user prompt to pi. */
  prompt(message) {
    this._write({ type: 'prompt', message });
  }

  /** Abort the current operation. */
  abort() {
    this._write({ type: 'abort' });
  }

  /** Start a fresh conversation (keeps the process alive). */
  newConversation() {
    this._write({ type: 'new_session' });
  }

  /** Kill the underlying process. */
  kill() {
    try {
      this._proc.kill();
    } catch (_) {}
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Get or create a session for the given chat, optionally in a specific cwd. */
function getOrCreateSession(chatId, cwd) {
  const existing = sessions.get(chatId);
  if (existing && (!cwd || existing.cwd === cwd)) return existing;

  // Different cwd or no session — start fresh
  if (existing) existing.kill();
  const session = new PiSession(chatId, cwd);
  sessions.set(chatId, session);
  return session;
}

/** Auth guard — returns true and replies if NOT allowed. */
function guardAuth(ctx) {
  if (!isAllowed(ctx.chat.id)) {
    ctx.reply('❌ Not authorized.').catch(() => {});
    return true;
  }
  return false;
}

// ── Bot commands ──────────────────────────────────────────────────────────────

bot.command('start', (ctx) => {
  if (guardAuth(ctx)) return;

  const existing = sessions.get(ctx.chat.id);
  if (existing) {
    existing.kill();
    sessions.delete(ctx.chat.id);
  }

  const session = new PiSession(ctx.chat.id);
  sessions.set(ctx.chat.id, session);

  ctx.reply(
    [
      '🟢 *Pi agent session started!*',
      '',
      'Just send me your prompts. I pass them directly to pi.',
      '',
      '*Commands:*',
      '`/start` — new session (kills current)',
      '`/stop` — end session',
      '`/new` — fresh conversation (same process)',
      '`/abort` — abort current operation',
      '`/status` — show session info',
      '`/repo <url-or-user/name>` — clone repo & switch into it',
    ].join('\n'),
    { parse_mode: 'Markdown' },
  );
});

bot.command('stop', (ctx) => {
  if (guardAuth(ctx)) return;
  const s = sessions.get(ctx.chat.id);
  if (s) {
    s.kill();
    sessions.delete(ctx.chat.id);
    ctx.reply('🔴 Session stopped.');
  } else {
    ctx.reply('No active session. Use /start to begin.');
  }
});

bot.command('new', (ctx) => {
  if (guardAuth(ctx)) return;
  const s = sessions.get(ctx.chat.id);
  if (s) {
    s.newConversation();
    ctx.reply('🔄 Fresh conversation started (pi process kept alive).');
  } else {
    ctx.reply('No active session. Use /start to begin.');
  }
});

bot.command('abort', (ctx) => {
  if (guardAuth(ctx)) return;
  const s = sessions.get(ctx.chat.id);
  if (s) {
    s.abort();
    ctx.reply('⛔ Sent abort signal to pi.');
  } else {
    ctx.reply('No active session.');
  }
});

bot.command('status', (ctx) => {
  if (guardAuth(ctx)) return;
  const s = sessions.get(ctx.chat.id);
  if (s) {
    ctx.reply(
      `🟢 *Session active*${s.isStreaming ? ' · ⏳ processing' : ''}\nWorkdir: \`${s.cwd}\``,
      { parse_mode: 'Markdown' },
    );
  } else {
    ctx.reply('🔴 No active session. Use /start to begin.');
  }
});

bot.command('repo', async (ctx) => {
  if (guardAuth(ctx)) return;

  const args = ctx.message.text.split(/\s+/).slice(1);
  if (!args.length) {
    return ctx.reply(
      [
        'Usage: `/repo <url-or-shorthand>`',
        'Examples:',
        '  `/repo kirhgoff/blakablaka`',
        '  `/repo https://github.com/kirhgoff/note-ninja-nextjs`',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    );
  }

  let url = args[0];
  if (!url.startsWith('http')) url = `https://github.com/${url}.git`;

  const repoName = url.replace(/\.git$/, '').split('/').pop();
  const repoPath = path.join(WORKSPACE, repoName);

  if (fs.existsSync(repoPath)) {
    await ctx.reply(`📁 Already cloned at \`${repoPath}\``, { parse_mode: 'Markdown' });
  } else {
    await ctx.reply(`📥 Cloning \`${url}\`…`, { parse_mode: 'Markdown' });
    try {
      execSync(`git clone ${url} ${repoPath}`, { stdio: 'pipe' });
    } catch (err) {
      const msg = err.stderr?.toString().trim() || err.message;
      return ctx.reply(`❌ Clone failed:\n\`${msg}\``, { parse_mode: 'Markdown' });
    }
    await ctx.reply(`✅ Cloned to \`${repoPath}\``, { parse_mode: 'Markdown' });
  }

  // Start (or restart) a pi session rooted in the repo
  const existing = sessions.get(ctx.chat.id);
  if (existing) existing.kill();
  const session = new PiSession(ctx.chat.id, repoPath);
  sessions.set(ctx.chat.id, session);
  ctx.reply(`🟢 Pi session now in \`${repoPath}\``, { parse_mode: 'Markdown' });
});

// ── Default: forward all text messages to pi ──────────────────────────────────

bot.on('text', async (ctx) => {
  if (guardAuth(ctx)) return;

  // Auto-start a session if none exists
  if (!sessions.has(ctx.chat.id)) {
    const session = new PiSession(ctx.chat.id);
    sessions.set(ctx.chat.id, session);
    // Brief pause so pi's process can initialise its stdin listener
    await new Promise((r) => setTimeout(r, 300));
  }

  sessions.get(ctx.chat.id)?.prompt(ctx.message.text);
});

// ── Launch ────────────────────────────────────────────────────────────────────

bot.launch({ dropPendingUpdates: true });
console.log('🤖 Pi Telegram bot running');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
