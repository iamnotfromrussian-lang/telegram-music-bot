// bot.js — Telegram Music Bot (с улучшениями и оптимизацией)
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
  .split(',').map(id => id.trim()).filter(Boolean);
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
  } else fs.writeFileSync(DATA_FILE, '[]', 'utf8');
} catch {
  trackList = [];
}
function safeSave() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(trackList, null, 2), 'utf8'); }
  catch (e) { console.error('⚠️ Ошибка сохранения:', e.message); }
}

// состояние пагинации: userId -> { key, page }
const paginationState = new Map();

// «временные показы» аудио: userId -> { trackId, msgIds: number[] }
const tempPlays = new Map();

// ────────────────────────────────
// Веб-сервер (для Render health check)
// ────────────────────────────────
const app = express();
app.get('/', (_, res) => res.send('✅ Telegram Music Bot активен'));
app.listen(PORT, () => console.log(`🌐 Сервер запущен на порту ${PORT}`));

// ────────────────────────────────
// Основной бот
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

/**
 * Ищет трек по ID и отправляет оповещение, если трек не найден.
 * @param {import('telegraf').Context} ctx
 * @param {string} id
 * @returns {object | null}
 */
function findTrackAndCheck(ctx, id) {
    const tr = trackList.find(t => t.id === id);
    if (!tr) {
        ctx.answerCbQuery('❌ Трек не найден или был удален', { show_alert: true });
        return null;
    }
    return tr;
}

// ────────────────────────────────
// Пагинация (исправленная)
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

  if (!list.length) {
    // 🟢 Корректировка: Удаляем состояние, если список пуст
    paginationState.delete(String(ctx.from.id)); 
    return ctx.reply('Список пуст.', mainMenu);
  }

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

async function refreshPagination(ctx) {
  const state = paginationState.get(String(ctx.from.id));
  if (!state) return;
  const { key, page } = state;
  const list = pickListByKey(key, ctx.from.id);
  const titleMap = {
    all: '📋 Список треков',
    mine: '🎧 Твои треки',
    orig: '📀 Оригинальные',
    cover: '🎤 Кавер-версии',
    global: '🌍 Топ за всё время',
    week: '🏆 Топ за неделю'
  };
  await showTracks(ctx, list, titleMap[key] || '📋 Список треков', page);
}

bot.action(/^page_(.+)_(\d+)$/, async (ctx) => {
  const key = ctx.match[1];
  const page = parseInt(ctx.match[2]);
  const list = pickListByKey(key, ctx.from.id);
  const titleMap = {
    all: '📋 Список треков',
    mine: '🎧 Твои треки',
    orig: '📀 Оригинальные',
    cover: '🎤 Кавер-версии',
    global: '🌍 Топ за всё время',
    week: '🏆 Топ за неделю'
  };
  await showTracks(ctx, list, titleMap[key] || '📋 Список треков', page);
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

    const safeName = (file.file_name || file.title || `track_${Date.now()}.mp3`).replace(/[\\/:*?"<>|]+/g, '_');
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
      messages: [{ chatId: ctx.chat.id, messageId: ctx.message.message_id }] // Оригинальное аудио
    };

    const addedMsg = await ctx.reply(`✅ Трек добавлен: ${safeName}`);
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

    // 🟢 Корректировка: Удаляем служебные сообщения после сохранения
    deleteLater(ctx, addedMsg, 100); // Удаляем ✅ Трек добавлен
    
  } catch (e) {
    console.error('audio handler error:', e);
    ctx.reply('❌ Не удалось обработать файл.').catch(() => {});
  }
});

// ────────────────────────────────
// Inline-действия (лайки / удаление / тип)
// ────────────────────────────────
bot.action(/^type_(.+)_(original|cover)$/, async (ctx) => {
  const [, id, type] = ctx.match;
  const tr = findTrackAndCheck(ctx, id);
  if (!tr) return;

  tr.type = type;
  safeSave();

  // 🟢 Корректировка: Удаляем служебные сообщения (TypeMsg) и даем обратную связь
  
  // Удаляем "Выбери тип трека"
  await ctx.deleteMessage().catch(() => {});

  // Обновляем массив сообщений, оставляя только оригинальное аудио [0] и лайк-панель [3]
  // (если индексы не менялись при приеме аудио)
  if (tr.messages.length > 3) {
    // Удаляем ссылки на сообщения: ✅ Добавлен [1], Выбор типа [2]
    for (const m of tr.messages.slice(1, 3)) {
      await ctx.telegram.deleteMessage(m.chatId, m.messageId).catch(() => {});
    }
    // Оставляем только оригинальное аудио и лайк-панель
    tr.messages = [tr.messages[0], tr.messages[3]].filter(Boolean); 
  }


  const ok = await ctx.reply(`✔️ Тип установлен: ${type === 'original' ? '📀 Оригинальный' : '🎤 Cover Version'}`);
  deleteLater(ctx, ok, 1500);
  await ctx.answerCbQuery();
});


bot.action(/^like_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const tr = findTrackAndCheck(ctx, id);
  if (!tr) return;

  const uid = ctx.from.id;
  const i = tr.voters.indexOf(uid);
  let toast;

  if (i >= 0) {
    tr.voters.splice(i, 1);
    toast = await ctx.reply('💤 Лайк снят');
  } else {
    tr.voters.push(uid);
    const eff = await ctx.reply(likeEffect());
    deleteLater(ctx, eff, 1200);
    toast = await ctx.reply('🔥 Лайк поставлен');
  }

  deleteLater(ctx, toast, 1200);
  safeSave();
  
  // 🟢 Корректировка: Устойчивое обновление лайк-панелей
  const updatedMessages = [];
  for (const m of tr.messages || []) {
    try {
      const { text, keyboard } = likeBar(tr, ctx.from.id);
      await ctx.telegram.editMessageText(m.chatId, m.messageId, undefined, text, {
        reply_markup: keyboard.reply_markup
      });
      updatedMessages.push(m); // Сообщение успешно обновлено
    } catch (e) {
      // Игнорируем ошибку, если сообщение не найдено (удалено пользователем)
      if (!String(e.message).includes('message to edit not found')) {
        console.error('Ошибка обновления лайк-панели:', e.message);
        updatedMessages.push(m); // Если это другая ошибка, сохраняем ссылку
      }
    }
  }
  tr.messages = updatedMessages; // Обновляем список, удаляя несуществующие сообщения

  await ctx.answerCbQuery();
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

  const info = await ctx.reply(`🧹 Трек "${tr.title}" удалён.`);
  deleteLater(ctx, info, 1800);
  await refreshPagination(ctx);
  await ctx.answerCbQuery('Удалено');
});

bot.action(/^play_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const tr = findTrackAndCheck(ctx, id);
  if (!tr) return;

  const uid = String(ctx.from.id);
  const prev = tempPlays.get(uid);
  if (prev && prev.msgIds?.length) {
    for (const mid of prev.msgIds) {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, mid); } catch {}
    }
    tempPlays.delete(uid);
  }

  const origin = (tr.messages || [])[0];
  let newIds = [];
  try {
    if (origin) {
      const cp = await ctx.telegram.copyMessage(ctx.chat.id, origin.chatId, origin.messageId, { caption: tr.title });
      newIds.push(cp.message_id);
    } else {
      const fallback = await ctx.reply(`▶️ ${tr.title}`);
      newIds.push(fallback.message_id);
    }
    const { text, keyboard } = likeBar(tr, ctx.from.id);
    const likeMsg = await ctx.reply(text, keyboard);
    newIds.push(likeMsg.message_id);
  } catch {}

  tempPlays.set(uid, { trackId: tr.id, msgIds: newIds });
  setTimeout(async () => {
    const cur = tempPlays.get(uid);
    if (cur && cur.trackId === tr.id) {
      for (const mid of cur.msgIds) {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, mid); } catch {}
      }
      tempPlays.delete(uid);
    }
  }, 60000);

  await ctx.answerCbQuery();
});

// ────────────────────────────────
// Глобальный catch + авто-перезапуск
// ────────────────────────────────
bot.catch(err => {
  console.error('⚠️ Ошибка:', err.code || err.message);
  if (['ECONNRESET', 'ETIMEDOUT', 'EFATAL'].includes(err.code)) {
    console.log('🌐 Потеря соединения. Перезапуск через 10 секунд...');
    setTimeout(() => process.exit(1), 10000);
  }
});

// ────────────────────────────────
// Запуск
// ────────────────────────────────
bot.launch().then(() => console.log('🤖 Бот запущен и готов'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));



