// bot.js — Telegram Music Bot (фикс: без автоудаления, стабильные лайки и автосохранение)
// npm i telegraf express dotenv

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import path from 'path';
import express from 'express';

// ────────────────────────────────
// Конфигурация
// ────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN отсутствует в .env');
  process.exit(1);
}
const ADMIN_IDS = (process.env.ADMIN_IDS || '1100564590')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);
const isAdmin = (id) => ADMIN_IDS.includes(String(id));

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(process.cwd(), 'trackList.json');

// ────────────────────────────────
// Хранилище
// ────────────────────────────────
let trackList = [];
try {
  if (fs.existsSync(DATA_FILE)) {
    trackList = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(trackList)) trackList = [];
  } else fs.writeFileSync(DATA_FILE, '[]', 'utf8');
} catch {
  trackList = [];
}

function safeSave() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(trackList, null, 2), 'utf8');
  } catch (e) {
    console.error('⚠️ Ошибка сохранения:', e.message);
  }
}

// ────────────────────────────────
// Состояние
// ────────────────────────────────
const paginationState = new Map();
const tempPlays = new Map();

// ────────────────────────────────
// Веб-сервер
// ────────────────────────────────
const app = express();
app.get('/', (_, res) => res.send('✅ Telegram Music Bot активен'));
app.listen(PORT, () => console.log(`🌐 Сервер запущен на порту ${PORT}`));

// ────────────────────────────────
// Инициализация бота
// ────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
const LIKE_EFFECTS = ['💞', '💫', '💥', '💎', '🔥'];
const likeEffect = () => LIKE_EFFECTS[Math.floor(Math.random() * LIKE_EFFECTS.length)];

const mainMenu = Markup.keyboard([
  ['📋 Список треков', '🎧 Мои треки'],
  ['📀 Оригинальные', '🎤 Кавер-версии'],
  ['🏆 Топ за неделю', '🌍 Топ за всё время'],
  ['📊 Статистика']
]).resize();

function deleteLater(ctx, msg, delayMs = 1500) {
  if (!msg) return;
  setTimeout(() => ctx.telegram.deleteMessage(msg.chat.id, msg.message_id).catch(() => {}), delayMs);
}

function likeBar(track, userId) {
  const liked = track.voters?.includes(userId);
  const text = `❤️ ${track.voters.length} — ${track.title}`;
  const row = [Markup.button.callback(liked ? '💔 Убрать лайк' : '❤️ Поставить лайк', `like_${track.id}`)];
  if (isAdmin(userId)) row.push(Markup.button.callback('🗑 Удалить', `del_${track.id}`));
  return { text, keyboard: Markup.inlineKeyboard([row]) };
}

// ────────────────────────────────
// Пагинация
// ────────────────────────────────
function getListKey(title) {
  if (title.includes('📋')) return 'all';
  if (title.includes('🎧')) return 'mine';
  if (title.includes('📀')) return 'orig';
  if (title.includes('🎤')) return 'cover';
  if (title.includes('🌍')) return 'global';
  if (title.includes('🏆')) return 'week';
  return 'all';
}

function titleByKey(key) {
  return ({
    all: '📋 Список треков',
    mine: '🎧 Твои треки',
    orig: '📀 Оригинальные',
    cover: '🎤 Кавер-версии',
    global: '🌍 Топ за всё время',
    week: '🏆 Топ за неделю'
  })[key] || '📋 Список треков';
}

function pickListByKey(key, userId) {
  switch (key) {
    case 'mine': return trackList.filter(t => t.userId === userId);
    case 'orig': return trackList.filter(t => t.type === 'original');
    case 'cover': return trackList.filter(t => t.type === 'cover');
    case 'global': return [...trackList].sort((a, b) => b.voters.length - a.voters.length);
    case 'week': {
      const weekAgo = Date.now() - 7 * 86400000;
      return trackList.filter(t => new Date(t.createdAt).getTime() >= weekAgo)
                      .sort((a, b) => b.voters.length - a.voters.length);
    }
    default: return trackList;
  }
}

async function showTracks(ctx, list, title, page = 1) {
  const perPage = 10;
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  page = Math.min(Math.max(1, page), totalPages);

  const key = getListKey(title);
  paginationState.set(String(ctx.from.id), { key, page });

  if (!list.length) return ctx.reply('Список пуст.', mainMenu);

  const start = (page - 1) * perPage;
  const slice = list.slice(start, start + perPage);

  const buttons = slice.map(t => [Markup.button.callback(`▶️ ${t.title} • ❤️ ${t.voters.length}`, `play_${t.id}`)]);
  const nav = [];
  if (page > 1) nav.push(Markup.button.callback('⬅️ Назад', `page_${key}_${page - 1}`));
  if (page < totalPages) nav.push(Markup.button.callback('➡️ Далее', `page_${key}_${page + 1}`));
  if (nav.length) buttons.push(nav);

  const header = `${title} (стр. ${page}/${totalPages})`;
  await ctx.reply(header, Markup.inlineKeyboard(buttons, { columns: 1 }));
}

bot.action(/^page_(.+)_(\d+)$/, async (ctx) => {
  const key = ctx.match[1];
  const page = parseInt(ctx.match[2]);
  const list = pickListByKey(key, ctx.from.id);
  await showTracks(ctx, list, titleByKey(key), page);
  await ctx.answerCbQuery();
});

// ────────────────────────────────
// Команды
// ────────────────────────────────
bot.start(ctx => ctx.reply(
  '🎵 Привет! Отправь аудио — добавлю в плейлист.\n\nℹ️ Можно загружать до 100 МБ. Используй меню ниже для навигации.',
  mainMenu
));

bot.hears('📊 Статистика', ctx => {
  const users = new Set(trackList.map(t => t.userId)).size;
  const totalLikes = trackList.reduce((s, t) => s + t.voters.length, 0);
  ctx.reply(`📊 Статистика:\n👥 Пользователей: ${users}\n🎵 Треков: ${trackList.length}\n❤️ Голосов: ${totalLikes}`, mainMenu);
});

bot.hears('📋 Список треков', ctx => showTracks(ctx, trackList, '📋 Список треков', 1));
bot.hears('🎧 Мои треки', ctx => showTracks(ctx, trackList.filter(t => t.userId === ctx.from.id), '🎧 Твои треки', 1));
bot.hears('📀 Оригинальные', ctx => showTracks(ctx, trackList.filter(t => t.type === 'original'), '📀 Оригинальные', 1));
bot.hears('🎤 Кавер-версии', ctx => showTracks(ctx, trackList.filter(t => t.type === 'cover'), '🎤 Кавер-версии', 1));
bot.hears('🌍 Топ за всё время', ctx => showTracks(ctx, [...trackList].sort((a, b) => b.voters.length - a.voters.length), '🌍 Топ за всё время', 1));
bot.hears('🏆 Топ за неделю', ctx => {
  const weekAgo = Date.now() - 7 * 86400000;
  const week = trackList.filter(t => new Date(t.createdAt).getTime() >= weekAgo)
                        .sort((a, b) => b.voters.length - a.voters.length);
  showTracks(ctx, week, '🏆 Топ за неделю', 1);
});

// ────────────────────────────────
// Приём аудио
// ────────────────────────────────
bot.on(['audio', 'document'], async (ctx) => {
  try {
    const file = ctx.message.audio || ctx.message.document;
    if (!file) return;

    const exists = trackList.some(t => t.fileId === file.file_id || t.fileUniqueId === file.file_unique_id);
    if (exists) {
      const warn = await ctx.reply('⚠️ Такой трек уже есть в списке.');
      deleteLater(ctx, warn, 2500);
      return;
    }

    const safeName = (file.file_name || `track_${Date.now()}.mp3`).replace(/[\\/:*?"<>|]+/g, '_');
    const id = `${file.file_unique_id}_${Date.now()}`;

    const track = {
      id,
      fileId: file.file_id,
      fileUniqueId: file.file_unique_id,
      title: safeName,
      userId: ctx.from.id,
      voters: [],
      createdAt: new Date().toISOString(),
      type: 'original',
      messages: [{ chatId: ctx.chat.id, messageId: ctx.message.message_id }]
    };

    const addedMsg = await ctx.reply(`✅ Трек добавлен: ${safeName}`);
    deleteLater(ctx, addedMsg, 2000);
    track.messages.push({ chatId: addedMsg.chat.id, messageId: addedMsg.message_id });

    const typeMsg = await ctx.reply(
      'Выбери тип трека:',
      Markup.inlineKeyboard([
        [Markup.button.callback('📀 Оригинальный', `type_${id}_original`)],
        [Markup.button.callback('🎤 Cover Version', `type_${id}_cover`)]
      ])
    );
    track.messages.push({ chatId: typeMsg.chat.id, messageId: typeMsg.message_id });

    const { text, keyboard } = likeBar(track, ctx.from.id);
    const likeMsg = await ctx.reply(text, keyboard);
    track.messages.push({ chatId: likeMsg.chat.id, messageId: likeMsg.message_id });

    trackList.push(track);
    safeSave();
  } catch (e) {
    console.error('audio handler error:', e);
    ctx.reply('❌ Не удалось обработать файл.').catch(() => {});
  }
});

// ────────────────────────────────
// Inline-действия
// ────────────────────────────────
bot.action(/^type_(.+)_(original|cover)$/, async (ctx) => {
  const [, id, type] = ctx.match;
  const tr = trackList.find(t => t.id === id);
  if (!tr) return ctx.answerCbQuery('Не найден');
  tr.type = type;
  safeSave();
  await ctx.editMessageText(`✅ Тип установлен: ${type === 'original' ? '📀 Оригинальный' : '🎤 Cover Version'}`).catch(() => {});
  await ctx.answerCbQuery('Сохранено');
});

bot.action(/^like_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const tr = trackList.find(t => t.id === id);
  if (!tr) return ctx.answerCbQuery('Не найден');

  const uid = ctx.from.id;
  const i = tr.voters.indexOf(uid);
  if (i >= 0) tr.voters.splice(i, 1); else tr.voters.push(uid);
  safeSave();

  for (const m of tr.messages || []) {
    try {
      const { text, keyboard } = likeBar(tr, ctx.from.id);
      await ctx.telegram.editMessageText(m.chatId, m.messageId, undefined, text, {
        reply_markup: keyboard.reply_markup
      });
    } catch {}
  }

  await ctx.answerCbQuery('✅');
});

bot.action(/^del_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет прав', { show_alert: true });
  const id = ctx.match[1];
  const idx = trackList.findIndex(t => t.id === id);
  if (idx === -1) return ctx.answerCbQuery('Не найден');
  const tr = trackList[idx];

  for (const m of tr.messages || []) {
    await ctx.telegram.deleteMessage(m.chatId, m.messageId).catch(() => {});
  }

  trackList.splice(idx, 1);
  safeSave();
  await ctx.reply(`🧹 Трек "${tr.title}" удалён.`);
  await ctx.answerCbQuery('Удалено');
});

// отключено автоудаление (раньше было через 60000)
bot.action(/^play_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const tr = trackList.find(t => t.id === id);
  if (!tr) return ctx.answerCbQuery('Не найден');
  const origin = (tr.messages || [])[0];
  try {
    if (origin) await ctx.telegram.copyMessage(ctx.chat.id, origin.chatId, origin.messageId, { caption: tr.title });
    else await ctx.reply(`▶️ ${tr.title}`);
  } catch {}
  await ctx.answerCbQuery();
});

// ────────────────────────────────
// Глобальный catch + авто-рестарт
// ────────────────────────────────
bot.catch(err => {
  console.error('⚠️ Ошибка:', err.code || err.message);
  if (['ECONNRESET', 'ETIMEDOUT', 'EFATAL'].includes(err.code)) {
    console.log('🌐 Потеря соединения. Перезапуск через 10 секунд...');
    setTimeout(() => process.exit(1), 10000);
  }
});

// ping для Render
setInterval(() => { safeSave(); }, 2 * 60 * 1000);

// ────────────────────────────────
// Запуск
// ────────────────────────────────
bot.launch().then(() => console.log('🤖 Бот запущен и готов'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));




