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

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || 'https://docs.google.com/spreadsheets/d/1mGpGXgSFFVfkrO8gmGHhvdIkI_Yg94oi68QL-OULGYM/edit?gid=1623407110#gid=1623407110';

const DEFAULT_PRESETS = [
  {
    id: 'totoro',
    name: 'Тоторо (Живий)',
    url: '/totoro.mp4',
    mobileUrl: '/totoro-mobile.mp4',
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
    mobileUrl: '/emerald-rain-mobile.mp4',
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
    mobileUrl: 'https://images.unsplash.com/photo-1550684848-fac1c5b4e853?q=80&w=800',
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

// Формування посилання CSV експорту
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

// Парсер CSV
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

// Кеш таблиці
let scheduleDb = {
  today: {},
  tomorrow: {},
  metaText: '',
  sourceChannel: 't.me/poltavska_bezsvitla',
  lastUpdatedTime: null
};

// Зсув 30 хвилин назад для "жовтої зони": "02:30" -> "02:00"
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

    // Рядок 2 зі скріншоту: "Обновлено: 17.10.2026 17:12:01 | Источник: t.me/poltavska_bezsvitla"
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

      // Якщо в секції "Завтра" стоїть повідомлення про очікування публікації
      if (currentSection === 'tomorrow' && (rowStr.includes('пока не опубликован') || rowStr.includes('Ожидается публикация'))) {
        continue;
      }

      // Шукаємо чергу у рядку (Черга 1.1 - 6.2)
      let queueKey = null;
      for (const cell of row) {
        const qm = cell.match(/(?:Черга|Очередь)?\s*([1-6]\.[1-2])/i);
        if (qm) {
          queueKey = qm[1];
          break;
        }
      }
      if (!queueKey) continue;

      // Знаходимо періоди відключень (Колонка C або вільний пошук інтервалів)
      const slotMatches = [...rowStr.matchAll(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/g)];
      const parsedSlots = [];

      for (const m of slotMatches) {
        const rawStart = m[1];
        const rawEnd = m[2];

        // Головна зміна: 30 хвилин необов'язкові
        // Якщо 00:00-02:30 -> effectiveEnd = 02:00, hasBuffer = true
        const effectiveEnd = getEffectiveEndTime(rawEnd);
        const hasBuffer = rawEnd.endsWith(':30');

        parsedSlots.push({
          start: rawStart,
          end: effectiveEnd,               // розрахунковий час для таймера
          rawEnd: rawEnd === '24:00' ? '23:59' : rawEnd, // вихідний час для відображення в дужках
          hasBuffer,                       // прапорець жовтої зони +30 хв
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

    console.log(`[Google Sheets] Таблицю оновлено. Час з таблиці: ${metaUpdated}`);
  } catch (err) {
    console.error('[Google Sheets] Помилка синхронізації:', err.message);
  }
}

// Оновлювати кожні 15 хвилин
setInterval(syncSheet, 15 * 60 * 1000);
syncSheet();

app.get('/api/status', (req, res) => {
  const queue = (req.query.queue || '3.2').replace('-', '.');
  const day = req.query.day || 'today';

  const dayMap = day === 'tomorrow' ? scheduleDb.tomorrow : scheduleDb.today;
  const rawSlots = dayMap[queue] || [];

  // Формуємо повний 24-годинний таймлайн зі станами "on" та "off"
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

// Допоміжна функція для побудови повної доби
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

// Пресети
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
    res.status(500).json({ error: 'Помилка збереження' });
  }
});

app.post('/api/feedback', (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !message) {
    return res.status(400).json({ error: "Будь ласка, заповніть ім'я та повідомлення" });
  }
  const list = getFeedbacks();
  list.unshift({
    id: Date.now().toString(),
    name: name.trim().slice(0, 100),
    email: (email || '').trim().slice(0, 150),
    message: message.trim().slice(0, 1500),
    createdAt: new Date().toISOString()
  });
  saveFeedbacks(list);
  res.json({ success: true, message: 'Дякуємо за ваш відгук!' });
});

app.post('/api/admin/feedbacks', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Доступ заборонено' });
  }
  res.json({ feedbacks: getFeedbacks() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LightNet запущено на порту ${PORT}`));