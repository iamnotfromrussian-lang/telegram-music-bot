// bot.js — Telegram Music Bot (anti-dup + pagination fix + auto-restart + MongoDB)
// npm i telegraf express dotenv mongoose

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose'; 

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

// ────────────────────────────────
// КОНФИГУРАЦИЯ БАЗЫ ДАННЫХ
// ────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;

// 1. Определение схемы трека (что мы храним о каждом треке)
const TrackSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  fileId: String,
  fileUniqueId: String,
  title: String,
  userId: Number,
  voters: [Number], // Массив ID пользователей, проголосовавших за трек
  createdAt: { type: Date, default: Date.now },
  type: { type: String, enum: ['original', 'cover'], default: 'original' },
  messages: [{ chatId: Number, messageId: Number }] // Добавлено для отслеживания всех сообщений с треком
});

// 2. Создание модели, которая позволяет нам взаимодействовать с коллекцией 'tracks'
const TrackModel = mongoose.model('Track', TrackSchema);

// 3. Функция подключения к БД (будет вызвана при запуске бота)
async function connectDB() {
  if (!MONGO_URI) {
    console.error('❌ MONGO_URI отсутствует. Бот не запустится.');
    process.exit(1);
  }
  try {
    await mongoose.connect(MONGO_URI);
    console.log('💾 Успешное подключение к MongoDB.');
  } catch (e) {
    console.error('⚠️ Ошибка подключения к MongoDB:', e.message);
    // Выход из процесса, если подключение не удалось
    setTimeout(() => process.exit(1), 5000); 
  }
}

// 🛑 Временные данные, которые не хранятся в БД:
const paginationState = new Map(); // состояние пагинации: userId -> { key, page }
const tempPlays = new Map(); // «временные показы» аудио: userId -> { trackId, msgIds: number[] }
// const listMsgHistory = new Map(); // Если эта переменная используется, убедитесь, что она объявлена.

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
  // 🛑 ИСПРАВЛЕНИЕ: Явная проверка на наличие поля voteCount (из агрегации), иначе используем длину массива.
  const voteCount = track.voteCount !== undefined ? track.voteCount : (track.voters?.length ?? 0);
  const liked = track.voters?.includes(userId);
  const text = `❤️ ${voteCount} — ${track.title}`;
  const row = [Markup.button.callback(liked ? '💔 Убрать лайк' : '❤️ Поставить лайк', `like_${track.id}`)];
  if (isAdmin(userId)) row.push(Markup.button.callback('🗑 Удалить', `del_${track.id}`));
  return { text, keyboard: Markup.inlineKeyboard([row]) };
}
// ────────────────────────────────
// Пагинация (MongoDB)
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

/**
 * Получает список треков из MongoDB в зависимости от ключа фильтрации.
 * 🟢 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Используем aggregate() для сортировки по лайкам (длине массива)
 * @param {string} key - Ключ фильтрации (mine, orig, cover, global, week).
 * @param {number} userId - ID пользователя для фильтрации "Мои треки".
 * @returns {Promise<Array<Object>>} - Промис, возвращающий список треков (Mongoose documents или plain objects).
 */
async function pickListByKey(key, userId) {
  switch (key) {
    case 'mine': 
      // Мои треки: фильтр по userId, сортировка по дате (новые сверху)
      return TrackModel.find({ userId }).sort({ createdAt: -1 });
    case 'orig': 
      // Оригинальные: фильтр по type: 'original', сортировка по дате
      return TrackModel.find({ type: 'original' }).sort({ createdAt: -1 });
    case 'cover': 
      // Каверы: фильтр по type: 'cover', сортировка по дате
      return TrackModel.find({ type: 'cover' }).sort({ createdAt: -1 });
    
    case 'global': 
      // 🟢 ИСПРАВЛЕНО: Топ за всё время - сортировка по количеству лайков через агрегацию
      return TrackModel.aggregate([
        { $addFields: { voteCount: { $size: "$voters" } } }, // Добавляем поле voteCount
        { $sort: { voteCount: -1, createdAt: -1 } } // Сортируем по voteCount DESC, затем по дате
      ]);

    case 'week': {
      // 🟢 ИСПРАВЛЕНО: Топ за неделю - сортировка по лайкам через агрегацию + фильтр по дате
      const weekAgo = new Date(Date.now() - 7 * 86400000);
      return TrackModel.aggregate([
        { $match: { createdAt: { $gte: weekAgo } } }, // 1. Фильтр по дате (последние 7 дней)
        { $addFields: { voteCount: { $size: "$voters" } } }, // 2. Добавляем поле voteCount
        { $sort: { voteCount: -1, createdAt: -1 } } // 3. Сортируем по voteCount DESC, затем по дате
      ]);
    }

    default: 
      // Общий список: все треки, сортировка по дате
      return TrackModel.find().sort({ createdAt: -1 });
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

  // 🟢 ИСПРАВЛЕНО: Ограничение длины и перенос лайков в начало
  const MAX_TITLE_LENGTH = 35; 
  
  const buttons = slice.map(t => {
    let displayTitle = t.title;
    if (displayTitle.length > MAX_TITLE_LENGTH) {
      displayTitle = displayTitle.substring(0, MAX_TITLE_LENGTH).trim() + '...';
    }
    // При агрегации у нас есть t.voteCount, иначе t.voters.length
    const voteCount = t.voters?.length ?? t.voteCount ?? 0;
    // Новый формат: ❤️ [Лайки] • ▶️ [Название]
    const buttonText = `❤️ ${voteCount} • ▶️ ${displayTitle}`; 
    return [Markup.button.callback(buttonText, `play_${t.id}`)];
  });
  
  // Логика навигации
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
  const list = await pickListByKey(key, ctx.from.id); // 🛑 ИСПОЛЬЗУЕТ MongoDB
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
  const list = await pickListByKey(key, ctx.from.id); // 🛑 ИСПОЛЬЗУЕТ MongoDB
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

bot.hears('📊 Статистика', async ctx => { // 🛑 ИСПОЛЬЗУЕТ MongoDB
  const totalTracks = await TrackModel.countDocuments(); // 🛑 ЗАМЕНА
  const users = await TrackModel.distinct('userId'); // 🛑 ЗАМЕНА
  // Агрегация для подсчета лайков
  const totalLikes = (await TrackModel.aggregate([{ $project: { _id: 0, likes: { $size: '$voters' } } }, { $group: { _id: null, total: { $sum: '$likes' } } }]))[0]?.total || 0;
  ctx.reply(`📊 Статистика:\n👥 Пользователей: ${users.length}\n🎵 Треков: ${totalTracks}\n❤️ Голосов: ${totalLikes}`, mainMenu);
});

// 🛑 ОБНОВЛЕННЫЕ КОМАНДЫ (СТАРЫЕ УДАЛЕНЫ)
bot.hears('📋 Список треков', async ctx => showTracks(ctx, await pickListByKey('all'), '📋 Список треков', 1));
bot.hears('🎧 Мои треки', async ctx => showTracks(ctx, await pickListByKey('mine', ctx.from.id), '🎧 Твои треки', 1));
bot.hears('📀 Оригинальные', async ctx => showTracks(ctx, await pickListByKey('orig'), '📀 Оригинальные', 1));
bot.hears('🎤 Кавер-версии', async ctx => showTracks(ctx, await pickListByKey('cover'), '🎤 Кавер-версии', 1));
bot.hears('🌍 Топ за всё время', async ctx => showTracks(ctx, await pickListByKey('global'), '🌍 Топ за всё время', 1));
bot.hears('🏆 Топ за неделю', async ctx => {
  const week = await pickListByKey('week');
  showTracks(ctx, week, '🏆 Топ за неделю', 1);
});

// ────────────────────────────────
// Приём аудио (MongoDB)
// ────────────────────────────────
bot.on(['audio', 'document'], async (ctx) => {
  try {
    const file = ctx.message.audio || ctx.message.document;
    if (!file) return;

    // 🛑 ЗАМЕНА: Проверка на дубликат через БД
    const exists = await TrackModel.exists({ $or: [{ fileId: file.file_id }, { fileUniqueId: file.file_unique_id }] });
    if (exists) {
      const warn = await ctx.reply('⚠️ Такой трек уже есть в списке.');
      deleteLater(ctx, warn, 2500);
      return;
    }

    const safeName = (file.file_name || `track_${Date.now()}.mp3`).replace(/[\\/:*?"<>|]+/g, '_');
    const id = `${file.file_unique_id}_${Date.now()}`;

    const trackData = { // 🛑 Используем объект для создания документа в БД
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
    trackData.messages.push({ chatId: addedMsg.chat.id, messageId: addedMsg.message_id });

    const typeMsg = await ctx.reply(
      'Выбери тип трека:',
      Markup.inlineKeyboard([
        [Markup.button.callback('📀 Оригинальный', `type_${id}_original`)],
        [Markup.button.callback('🎤 Cover Version', `type_${id}_cover`)]
      ])
    );
    trackData.messages.push({ chatId: typeMsg.chat.id, messageId: typeMsg.message_id });

    // Используем trackData для likeBar
    const { text, keyboard } = likeBar(trackData, ctx.from.id);
    const likeMsg = await ctx.reply(text, keyboard);
    trackData.messages.push({ chatId: likeMsg.chat.id, messageId: likeMsg.message_id });

    // 🛑 КРИТИЧЕСКАЯ ЗАМЕНА: Создание документа в БД
    await TrackModel.create(trackData); 
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
  // 🛑 ЗАМЕНА: Поиск трека по ID в БД
  const tr = await TrackModel.findOne({ id }); 
  if (!tr) return ctx.answerCbQuery('Не найден');
  
  tr.type = type;
  // 🛑 ЗАМЕНА: Сохранение изменений в БД
  await tr.save(); 

  await ctx.editMessageText(`✅ Тип установлен: ${type === 'original' ? '📀 Оригинальный' : '🎤 Cover Version'}`).catch(() => {});
  const ok = await ctx.reply('✔️ Сохранено');
  deleteLater(ctx, ok, 1000);
  await ctx.answerCbQuery();
});

bot.action(/^like_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  // 🛑 ЗАМЕНА: Поиск трека в БД
  const tr = await TrackModel.findOne({ id }); 
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
  // 🛑 КРИТИЧЕСКАЯ ЗАМЕНА: Сохранение изменений в БД
  await tr.save(); 

  // 2. Генерируем новый текст и кнопки
  const { text, keyboard } = likeBar(tr, ctx.from.id);

  // 3. Обновление ПОСТОЯННЫХ копий (загруженный трек)
  for (const m of tr.messages || []) {
    try {
      await ctx.telegram.editMessageText(m.chatId, m.messageId, undefined, text, {
        reply_markup: keyboard.reply_markup
      });
    } catch (e) {}
  }
  
  // 3.2. Обновление ВРЕМЕННОЙ лайк-панели (трек из списка)
  const tempState = tempPlays.get(String(uid));
  if (tempState && tempState.trackId === id && tempState.msgIds && tempState.msgIds.length > 1) {
    const likeMsgId = tempState.msgIds[tempState.msgIds.length - 1]; 
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, likeMsgId, undefined, text, {
        reply_markup: keyboard.reply_markup
      });
    } catch (e) {}
  }

  await ctx.answerCbQuery();
});

bot.action(/^del_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Нет прав', { show_alert: true });

  const id = ctx.match[1];
  // 🛑 ЗАМЕНА: Находим трек в БД
  const tr = await TrackModel.findOne({ id }); 
  if (!tr) return ctx.answerCbQuery('Не найден');

  // 1. УДАЛЕНИЕ ПОСТОЯННЫХ СООБЩЕНИЙ (кроме оригинального аудио)
  for (let i = (tr.messages?.length || 0) - 1; i > 0; i--) { 
    const m = tr.messages[i];
    await ctx.telegram.deleteMessage(m.chatId, m.messageId).catch(() => {});
  }

  // 2. УДАЛЕНИЕ ВРЕМЕННЫХ СООБЩЕНИЙ (play-сессий)
  for (const [uid, state] of tempPlays.entries()) {
    if (state.trackId === id && state.msgIds?.length) {
      for (const mid of state.msgIds) {
        await ctx.telegram.deleteMessage(ctx.chat.id, mid).catch(() => {});
      }
      tempPlays.delete(uid);
    }
  }
    
  // 3. УДАЛЕНИЕ СТАРОЙ ИСТОРИИ СООБЩЕНИЙ СО СПИСКАМИ (Если используется listMsgHistory, его надо объявить)
  // const uid = String(ctx.from.id);
  // const listIds = listMsgHistory.get(uid) || [];
  // for (const mid of listIds) {
  //   await ctx.telegram.deleteMessage(ctx.chat.id, mid).catch(() => {});
  // }
  // listMsgHistory.delete(uid);

  // 🛑 КРИТИЧЕСКАЯ ЗАМЕНА: Удаление документа из БД
  await TrackModel.deleteOne({ id }); 
  
  const info = await ctx.reply(`🧹 Трек "${tr.title}" удалён.`);
  deleteLater(ctx, info, 1800);
  
  await refreshPagination(ctx); 
  await ctx.answerCbQuery('Удалено');
});

bot.action(/^play_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  // 🛑 ИСПРАВЛЕНИЕ: Используем только findOne для получения полноценного документа.
  const tr = await TrackModel.findOne({ id }); 
  if (!tr) {
    // Это произойдет, если пользователь нажал на кнопку старого, удаленного трека
    return ctx.answerCbQuery('❌ Трек не найден (возможно, он был удален).'); 
  }

  const uid = String(ctx.from.id);
  const prev = tempPlays.get(uid);
  
  // Удаление предыдущего сообщения "Play"
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
      // Копируем оригинальный аудиофайл
      const cp = await ctx.telegram.copyMessage(ctx.chat.id, origin.chatId, origin.messageId, { caption: tr.title });
      newIds.push(cp.message_id);
    } else {
      // Запасной вариант
      const fallback = await ctx.reply(`▶️ ${tr.title}`);
      newIds.push(fallback.message_id);
    }
    
    // Используем likeBar с актуальным документом
    const { text, keyboard } = likeBar(tr, ctx.from.id); 
    const likeMsg = await ctx.reply(text, keyboard);
    newIds.push(likeMsg.message_id);
  } catch (e) {
    console.error('Play action error:', e);
  }

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
async function startBot() {
  // 🛑 КРИТИЧЕСКАЯ ЗАМЕНА: Сначала подключаемся к БД
  await connectDB(); 
  await bot.launch().then(() => console.log('🤖 Бот запущен и готов'));
}

startBot(); // 🛑 Запускаем асинхронную функцию startBot

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));





























