// bot.js — Telegram Music Bot (anti-dup + pagination fix + auto-restart)
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
  
  // 1. Явное извлечение Chat ID и Message ID для надежности
  const chatId = msg.chat?.id || ctx.chat.id;
  const messageId = msg.message_id;
  
  if (!chatId || !messageId) return;

  setTimeout(() => {
    // 2. Используем явно извлеченные ID
    ctx.telegram.deleteMessage(chatId, messageId).catch((e) => {
      const errMsg = String(e.message);
      // Игнорируем обычные ошибки (например, если сообщение уже удалено)
      if (!errMsg.includes('message to delete not found')) {
        // Если вы видите сообщение "message can't be deleted", значит, у бота нет прав.
        // console.error(`⚠️ Ошибка удаления сообщения ${messageId}:`, e.message);
      }
    });
  }, delayMs);
}

function likeBar(track, userId) {
  const liked = track.voters?.includes(userId);
  const text = `❤️ ${track.voters.length} — ${track.title}`;
  const row = [Markup.button.callback(liked ? '💔 Убрать лайк' : '❤️ Поставить лайк', `like_${track.id}`)];
  if (isAdmin(userId)) row.push(Markup.button.callback('🗑 Удалить', `del_${track.id}`));
  return { text, keyboard: Markup.inlineKeyboard([row]) };
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

  if (!list.length) return ctx.reply('Список пуст.', mainMenu);

  const start = (page - 1) * perPage;
  const slice = list.slice(start, start + perPage);

  // 🟢 ИСПРАВЛЕНИЕ: Ограничиваем длину названия трека, чтобы счетчик лайков был виден
  const MAX_TITLE_LENGTH = 35; // Можно скорректировать это число
  
  const buttons = slice.map(t => {
    let displayTitle = t.title;
    if (displayTitle.length > MAX_TITLE_LENGTH) {
      displayTitle = displayTitle.substring(0, MAX_TITLE_LENGTH).trim() + '...';
    }
    // Формат кнопки: ▶️ [Название] ... • ❤️ [Лайки]
    const buttonText = `▶️ ${displayTitle} • ❤️ ${t.voters.length}`;
    return [Markup.button.callback(buttonText, `play_${t.id}`)];
  });
  
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
// ────────────────────────────────
// Приём аудио (ДИАГНОСТИКА УДАЛЕНИЯ)
// ────────────────────────────────
bot.on(['audio', 'document'], async (ctx) => {
  try {
    const file = ctx.message.audio || ctx.message.document;
    if (!file) return;

    const exists = trackList.some(t => t.fileId === file.file_id || t.fileUniqueId === file.file_unique_id);
    
    if (exists) {
      // 🛑 ДИАГНОСТИКА: Пытаемся удалить сообщение пользователя СРАЗУ и ЛОГИРУЕМ ошибку
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id); 
        console.log('✅ УДАЛЕНИЕ: Сообщение пользователя успешно удалено.');
      } catch (e) {
        // Если удаление не удалось, ошибка будет здесь
        console.error('❌ ОШИБКА УДАЛЕНИЯ: Не удалось удалить сообщение пользователя:', e.message); 
        // Типичные ошибки: 'message can\'t be deleted' (нет прав) или 'message to delete not found' (редко)
      }

      // Отправляем предупреждение и удаляем его через 2.5 сек (используем вашу старую deleteLater)
      const warn = await ctx.reply('⚠️ Такой трек уже есть в списке.');
      deleteLater(ctx, warn, 2500); 
      return;
    }

    // ... (Остальная логика добавления нового трека без изменений)
    
    const safeName = (file.file_name || `track_${Date.now()}.mp3`).replace(/[\\/:*?"<>|]+/g, '_');
    const id = `${file.file_unique_id}_${Date.now()}`;

    const track = {
      // ... (объект track)
    };

    const addedMsg = await ctx.reply(`✅ Трек добавлен: ${safeName}`);
    deleteLater(ctx, addedMsg, 2000);
    track.messages.push({ chatId: addedMsg.chat.id, messageId: addedMsg.message_id });

    // ... (отправка typeMsg и likeMsg)

    trackList.push(track);
    safeSave();
  } catch (e) {
    console.error('audio handler error:', e);
    ctx.reply('❌ Не удалось обработать файл.').catch(() => {});
  }
});

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
// Inline-действия (лайки / удаление / тип)
// ────────────────────────────────
bot.action(/^type_(.+)_(original|cover)$/, async (ctx) => {
  const [, id, type] = ctx.match;
  const tr = trackList.find(t => t.id === id);
  if (!tr) return ctx.answerCbQuery('Не найден');
  tr.type = type;
  safeSave();

  await ctx.editMessageText(`✅ Тип установлен: ${type === 'original' ? '📀 Оригинальный' : '🎤 Cover Version'}`).catch(() => {});
  const ok = await ctx.reply('✔️ Сохранено');
  deleteLater(ctx, ok, 1000);
  await ctx.answerCbQuery();
});

bot.action(/^like_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const tr = trackList.find(t => t.id === id);
  if (!tr) return ctx.answerCbQuery('Не найден');
  const uid = ctx.from.id;
  const i = tr.voters.indexOf(uid);
  let toast;

  // 1. Логика добавления/удаления лайка
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

  // 2. Генерируем новый текст и кнопки
  const { text, keyboard } = likeBar(tr, ctx.from.id);

  // 3. ОБНОВЛЕНИЕ ВСЕХ КОПИЙ

  // 3.1. Обновление ПОСТОЯННЫХ копий (загруженный трек)
  for (const m of tr.messages || []) {
    try {
      // Пробуем отредактировать текущее сообщение (если это лайк-панель)
      await ctx.telegram.editMessageText(m.chatId, m.messageId, undefined, text, {
        reply_markup: keyboard.reply_markup
      });
    } catch (e) {
      // Игнорируем ошибки редактирования (сообщение-аудио, не найдено, не изменено)
    }
  }
  
  // 3.2. 🟢 ИСПРАВЛЕНИЕ: Обновление ВРЕМЕННОЙ лайк-панели (трек из списка)
  const tempState = tempPlays.get(String(uid));
  if (tempState && tempState.trackId === id && tempState.msgIds && tempState.msgIds.length > 1) {
    // Временная лайк-панель — это обычно последнее сообщение в tempPlays
    const likeMsgId = tempState.msgIds[tempState.msgIds.length - 1]; 
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, likeMsgId, undefined, text, {
        reply_markup: keyboard.reply_markup
      });
    } catch (e) {
      // Игнорируем ошибки
    }
  }

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
  const tr = trackList.find(t => t.id === id);
  if (!tr) return ctx.answerCbQuery('Не найден');

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

















