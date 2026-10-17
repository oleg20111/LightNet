const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PRESETS_FILE = path.join(__dirname, 'presets.json');
const FEEDBACKS_FILE = path.join(__dirname, 'feedbacks.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || 'https://docs.google.com/spreadsheets/d/1mGpGXgSFFVfkrO8gmGHhvdIkI_Yg94oi68QL-OULGYM/edit?gid=1623407110#gid=1623407110';

const DEFAULT_PRESETS = [
  {
    id: 'totoro',
    name: 'Тоторо (Живий)',
    url: '/totoro.mp4',
    mobileUrl: '',
    type: 'video',
    textColor: '#f6a090',
    greenColor: '#48dbfb',
    redColor: '#ff4757',
    dim: 55,
    pos: 72,
    scale: 100,
    glowEnabled: true,
    glowRadius: 25
  },
  {
    id: 'emerald',
    name: 'Смарагдовий дощ',
    url: '/emerald-rain.mp4',
    mobileUrl: '',
    type: 'video',
    textColor: '#48bb78',
    greenColor: '#38ef7d',
    redColor: '#55d6aa',
    dim: 45,
    pos: 50,
    scale: 100,
    glowEnabled: true,
    glowRadius: 25
  },
  {
    id: 'minimal',
    name: 'Мінімал',
    url: 'https://images.unsplash.com/photo-1550684848-fac1c5b4e853?q=80&w=800',
    mobileUrl: '',
    type: 'image',
    textColor: '#a4b0be',
    greenColor: '#2ed573',
    redColor: '#ff4757',
    dim: 65,
    pos: 50,
    scale: 100,
    glowEnabled: true,
    glowRadius: 25
  }
];

function getPresets() {
  try {
    if (!fs.existsSync(PRESETS_FILE)) {
      fs.writeFileSync(PRESETS_FILE, JSON.stringify(DEFAULT_PRESETS, null, 2), 'utf-8');
      return DEFAULT_PRESETS;
    }
    return JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf-8'));
  } catch (e) {
    return DEFAULT_PRESETS;
  }
}

function savePresets(presets) {
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2), 'utf-8');
}

function getFeedbacks() {
  try {
    if (!fs.existsSync(FEEDBACKS_FILE)) {
      fs.writeFileSync(FEEDBACKS_FILE, JSON.stringify([], null, 2), 'utf-8');
      return [];
    }
    return JSON.parse(fs.readFileSync(FEEDBACKS_FILE, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function saveFeedbacks(feedbacks) {
  fs.writeFileSync(FEEDBACKS_FILE, JSON.stringify(feedbacks, null, 2), 'utf-8');
}

function getSettings() {
  const envDefaults = {
    telegramEnabled: process.env.TELEGRAM_ENABLED === 'true' || Boolean(process.env.TELEGRAM_BOT_TOKEN),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || ''
  };

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const fileData = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      return {
        telegramEnabled: fileData.telegramEnabled ?? envDefaults.telegramEnabled,
        telegramBotToken: fileData.telegramBotToken || envDefaults.telegramBotToken,
        telegramChatId: fileData.telegramChatId || envDefaults.telegramChatId
      };
    }
  } catch (e) {
    console.error('[Settings] Помилка читання файлу налаштувань, використовуємо змінні оточення');
  }

  return envDefaults;
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

async function sendTelegramNotification(text) {
  const cfg = getSettings();
  if (!cfg.telegramEnabled || !cfg.telegramBotToken || !cfg.telegramChatId) {
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`;
    await axios.post(url, {
      chat_id: cfg.telegramChatId,
      text: text,
      parse_mode: 'HTML'
    }, { timeout: 8000 });
    console.log('[Telegram Notify] Сповіщення надіслано в Telegram');
  } catch (err) {
    console.error('[Telegram Notify] Помилка відправки:', err.response?.data?.description || err.message);
  }
}

function getDirectCsvUrl(url) {
  if (!url) return '';
  if (url.includes('/pub?') && url.includes('output=csv')) return url;

  const matchDoc = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (!matchDoc) return url;
  const docId = matchDoc[1];

  let gid = '0';
  const matchGid = url.match(/gid=([0-9]+)/);
  if (matchGid) gid = matchGid[1];

  return `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv&gid=${gid}`;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
  return lines.map(line => {
    const row = [];
    let insideQuotes = false;
    let entry = '';
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        insideQuotes = !insideQuotes;
      } else if (char === ',' && !insideQuotes) {
        row.push(entry.trim());
        entry = '';
      } else {
        entry += char;
      }
    }
    row.push(entry.trim());
    return row;
  });
}

let scheduleDb = {
  today: {},
  tomorrow: {},
  metaText: '',
  sourceChannel: 'https://t.me/poltavska_bezsvitla',
  lastUpdatedTime: null
};

function getEffectiveEndTime(endStr) {
  if (endStr.endsWith(':30')) {
    const [h] = endStr.split(':').map(Number);
    return `${h.toString().padStart(2, '0')}:00`;
  }
  if (endStr === '24:00') return '23:59';
  return endStr;
}

async function syncSheet() {
  const csvUrl = getDirectCsvUrl(GOOGLE_SHEET_URL);
  if (!csvUrl) return;

  try {
    const response = await axios.get(csvUrl, { timeout: 12000 });
    const rows = parseCSV(response.data);
    if (!rows || rows.length < 3) return;

    let metaUpdated = '';
    let sourceLink = 'https://t.me/poltavska_bezsvitla';

    for (let r = 0; r < Math.min(4, rows.length); r++) {
      const textRow = rows[r].join(' ');
      if (textRow.includes('Обновлено') || textRow.includes('Оновлено')) {
        const timeMatch = textRow.match(/(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})/);
        if (timeMatch) metaUpdated = timeMatch[1];

        const srcMatch = textRow.match(/(t\.me\/[a-zA-Z0-9_]+)/);
        if (srcMatch) sourceLink = `https://${srcMatch[1]}`;
        break;
      }
    }

    const todayMap = {};
    const tomorrowMap = {};
    let currentSection = 'today';

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const rowStr = row.join(' ');

      if (rowStr.includes('ГРАФИК НА ЗАВТРА') || rowStr.includes('ГРАФІК НА ЗАВТРА')) {
        currentSection = 'tomorrow';
        continue;
      } else if (rowStr.includes('ГРАФИК НА СЕГОДНЯ') || rowStr.includes('ГРАФІК НА СЬОГОДНІ')) {
        currentSection = 'today';
        continue;
      }

      if (currentSection === 'tomorrow' && (rowStr.includes('пока не опубликован') || rowStr.includes('Ожидается публикация'))) {
        continue;
      }

      let queueKey = null;
      for (const cell of row) {
        const qm = cell.match(/(?:Черга|Очередь)?\s*([1-6]\.[1-2])/i);
        if (qm) {
          queueKey = qm[1];
          break;
        }
      }
      if (!queueKey) continue;

      const slotMatches = [...rowStr.matchAll(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/g)];
      const parsedSlots = [];

      // В server.js внутри syncSheet при обходе slotMatches:
      for (const m of slotMatches) {
        const rawStart = m[1];
        const rawEnd = m[2];

        // Буфер 30 минут может быть ТОЛЬКО в конце интервала
        const hasBuffer = rawEnd.endsWith(':30');
        const effectiveEnd = rawEnd === '24:00' ? '23:59' : rawEnd;

        parsedSlots.push({
          start: rawStart,
          end: effectiveEnd,
          rawEnd: effectiveEnd,
          hasBuffer: hasBuffer,
          status: 'off'
        });
      }

      parsedSlots.sort((a, b) => a.start.localeCompare(b.start));

      const target = currentSection === 'tomorrow' ? tomorrowMap : todayMap;
      target[queueKey] = parsedSlots;
    }

    scheduleDb = {
      today: todayMap,
      tomorrow: tomorrowMap,
      metaText: metaUpdated,
      sourceChannel: sourceLink,
      lastUpdatedTime: new Date().toISOString()
    };

    console.log(`[Google Sheets] Базу оновлено з таблиці. Час: ${metaUpdated}`);
  } catch (err) {
    console.error('[Google Sheets] Помилка синхронізації:', err.message);
  }
}

setInterval(syncSheet, 15 * 60 * 1000);
syncSheet();

function generate24hTimeline(offSlots) {
  if (!offSlots || offSlots.length === 0) return [];

  const timeline = [];
  let cursor = '00:00';

  for (const off of offSlots) {
    if (off.start > cursor) {
      timeline.push({
        start: cursor,
        end: off.start,
        status: 'on'
      });
    }
    timeline.push(off);
    cursor = off.rawEnd || off.end;
  }

  if (cursor < '23:59' && cursor < '24:00') {
    timeline.push({
      start: cursor,
      end: '23:59',
      status: 'on'
    });
  }

  return timeline;
}

// Запит статусу розкладу
app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  const queue = (req.query.queue || '3.2').replace('-', '.');
  const day = req.query.day || 'today';

  const dayMap = day === 'tomorrow' ? scheduleDb.tomorrow : scheduleDb.today;
  const rawSlots = dayMap[queue] || [];
  const fullTimeline = generate24hTimeline(rawSlots);

  res.json({
    queue,
    day,
    slots: fullTimeline,
    metaUpdated: scheduleDb.metaText,
    sourceUrl: scheduleDb.sourceChannel,
    rawSourceUrl: GOOGLE_SHEET_URL,
    lastUpdated: scheduleDb.lastUpdatedTime || new Date().toISOString()
  });
});

// Вебхук для виклику з Google Apps Script
app.post('/api/webhook/sync', async (req, res) => {
  try {
    console.log('[Webhook] Отримано запит на синхронізацію з таблиці');
    await syncSheet();
    
    // Сповіщаємо всі відкриті сторінки браузера
    broadcastScheduleUpdate();

    res.json({ success: true, message: 'Синхронізацію виконано' });
  } catch (err) {
    console.error('[Webhook Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Зберігаємо підключені браузери для миттєвого пушу
let sseClients = [];

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

function broadcastScheduleUpdate() {
  sseClients.forEach(client => {
    client.write(`data: ${JSON.stringify({ type: 'SCHEDULE_UPDATED' })}\n\n`);
  });
}

app.get('/api/presets', (req, res) => {
  res.json(getPresets());
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/api/admin/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true, presets: getPresets() });
  }
  return res.status(401).json({ error: 'Невірний пароль адміністратора' });
});

app.post('/api/admin/presets', (req, res) => {
  const { password, presets } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Доступ заборонено' });
  }
  if (!Array.isArray(presets)) {
    return res.status(400).json({ error: 'Некоректний формат' });
  }
  try {
    savePresets(presets);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Помилка збереження файлу' });
  }
});

app.post('/api/feedback', async (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !message) {
    return res.status(400).json({ error: "Будь ласка, заповніть ім'я та повідомлення" });
  }

  const list = getFeedbacks();
  const newFeedback = {
    id: Date.now().toString(),
    name: name.trim().slice(0, 100),
    email: (email || '').trim().slice(0, 150),
    message: message.trim().slice(0, 1500),
    createdAt: new Date().toISOString()
  };

  list.unshift(newFeedback);
  saveFeedbacks(list);

  const tgText = `⚡ <b>Новий відгук на LightNet!</b>\n\n` +
                 `👤 <b>Ім'я:</b> ${newFeedback.name}\n` +
                 `📧 <b>Email:</b> ${newFeedback.email || 'Не вказано'}\n` +
                 `💬 <b>Повідомлення:</b>\n${newFeedback.message}\n\n` +
                 `🕒 <i>${new Date().toLocaleString('uk-UA')}</i>`;

  try {
    await sendTelegramNotification(tgText);
  } catch (err) {
    console.error('[Feedback Telegram Error]:', err.message);
  }

  res.json({ success: true, message: 'Дякуємо за ваш відгук!' });
});

app.post('/api/admin/feedbacks', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Доступ заборонено' });
  }
  res.json({ feedbacks: getFeedbacks() });
});

app.post('/api/admin/settings', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Доступ заборонено' });
  }
  res.json({ settings: getSettings() });
});

app.post('/api/admin/settings/save', (req, res) => {
  const { password, settings } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Доступ заборонено' });
  }
  try {
    saveSettings(settings);
    res.json({ success: true, message: 'Налаштування успішно збережено' });
  } catch (e) {
    res.status(500).json({ error: 'Помилка збереження налаштувань' });
  }
});

app.post('/api/admin/settings/test-telegram', async (req, res) => {
  const { password, botToken, chatId } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Доступ заборонено' });
  }
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text: '🔔 <b>LightNet</b>: Тестове сповіщення успішно надіслано в Telegram!',
      parse_mode: 'HTML'
    }, { timeout: 6000 });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.response?.data?.description || 'Не вдалося надіслати. Перевірте токен і Chat ID' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LightNet запущено на порту ${PORT}`));