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
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || 'https://docs.google.com/spreadsheets/d/1U-_DlB8zX1QLEt17PPnCuzrtvFR_q58c6l-SF7jZ-3E/edit?gid=1496515955#gid=1496515955';

const DEFAULT_PRESETS = [
  {
    id: 'totoro',
    name: 'Тоторо (Живий)',
    url: '/totoro.mp4',
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

// Конвертація посилання на Google Таблицю у прямий експорт CSV
function buildCsvExportUrl(url) {
  const docMatch = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (!docMatch) return url;
  const docId = docMatch[1];

  let gid = '0';
  const gidMatch = url.match(/gid=([0-9]+)/);
  if (gidMatch) gid = gidMatch[1];

  return `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv&gid=${gid}`;
}

// Парсер CSV у табличний масив рядків
function parseCsvRows(text) {
  const result = [];
  let row = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      row.push(current.trim());
      current = '';
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      if (c === '\r' && next === '\n') i++;
      row.push(current.trim());
      if (row.some(cell => cell.length > 0)) {
        result.push(row);
      }
      row = [];
      current = '';
    } else {
      current += c;
    }
  }
  if (current.length > 0 || row.length > 0) {
    row.push(current.trim());
    if (row.some(cell => cell.length > 0)) {
      result.push(row);
    }
  }
  return result;
}

// Кеш даних
let scheduleCache = {
  today: {},
  tomorrow: {},
  lastUpdated: null,
  sourceUrl: GOOGLE_SHEET_URL
};

// Нормалізація часу
function normalizeTime(t) {
  let [h, m] = t.split(':').map(Number);
  if (h === 24) return '23:59';
  return `${h.toString().padStart(2, '0')}:${(m || 0).toString().padStart(2, '0')}`;
}

// Завантаження й парсинг таблиці
async function updateScheduleFromGoogleSheets() {
  try {
    const csvUrl = buildCsvExportUrl(GOOGLE_SHEET_URL);
    const resp = await axios.get(csvUrl, { timeout: 12000 });
    const rows = parseCsvRows(resp.data);

    if (!rows || rows.length === 0) return;

    const todaySchedules = {};
    const tomorrowSchedules = {};
    let currentDayMode = 'today';

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const rowString = row.join(' ').toLowerCase();

      // Перемикання секції "Сьогодні" / "Завтра"
      if (rowString.includes('завтра') || rowString.includes('tomorrow') || rowString.includes('наступна доба')) {
        currentDayMode = 'tomorrow';
        continue;
      } else if (rowString.includes('сьогодні') || rowString.includes('today') || rowString.includes('поточна доба')) {
        currentDayMode = 'today';
        continue;
      }

      // Шукаємо чергу у рядку (1.1 - 6.2)
      let detectedQueue = null;
      for (const cell of row) {
        const m = cell.match(/(?:черга\s*|черга:\s*)?([1-6][\.\-][1-2])/i);
        if (m) {
          detectedQueue = m[1].replace('-', '.');
          break;
        }
      }

      if (!detectedQueue) continue;

      // Спосіб 1: Пошук прямих діапазонів часу ("16:30 - 19:00", "00:00 — 04:00")
      const slotMatches = [...rowString.matchAll(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/g)];
      const foundSlots = [];

      for (const match of slotMatches) {
        let start = normalizeTime(match[1]);
        let end = normalizeTime(match[2]);
        if (end === '24:00') end = '23:59';

        foundSlots.push({ start, end, status: 'off' });
      }

      // Спосіб 2: Якщо в рядку погодинні статуси відключення ("-", "відкл", "off", "немає")
      if (foundSlots.length === 0) {
        let hourStart = null;
        for (let col = 1; col < row.length; col++) {
          const val = row[col].toLowerCase();
          const isOff = val === '-' || val.includes('відкл') || val.includes('off') || val === 'х' || val === 'x';
          
          if (isOff && hourStart === null) {
            hourStart = col - 1; // припускаємо відлік годин
          } else if (!isOff && hourStart !== null) {
            const h1 = hourStart.toString().padStart(2, '0') + ':00';
            let h2 = (col - 1).toString().padStart(2, '0') + ':00';
            if (h2 === '24:00') h2 = '23:59';
            foundSlots.push({ start: h1, end: h2, status: 'off' });
            hourStart = null;
          }
        }
        if (hourStart !== null) {
          const h1 = hourStart.toString().padStart(2, '0') + ':00';
          foundSlots.push({ start: h1, end: '23:59', status: 'off' });
        }
      }

      const targetBucket = currentDayMode === 'tomorrow' ? tomorrowSchedules : todaySchedules;
      if (!targetBucket[detectedQueue]) {
        targetBucket[detectedQueue] = [];
      }
      targetBucket[detectedQueue].push(...foundSlots);
    }

    // Дедуплікація та сортування
    for (const q in todaySchedules) {
      todaySchedules[q] = cleanAndSortSlots(todaySchedules[q]);
    }
    for (const q in tomorrowSchedules) {
      tomorrowSchedules[q] = cleanAndSortSlots(tomorrowSchedules[q]);
    }

    scheduleCache = {
      today: todaySchedules,
      tomorrow: tomorrowSchedules,
      lastUpdated: new Date().toISOString(),
      sourceUrl: GOOGLE_SHEET_URL
    };

    console.log(`[Google Sheets] Таблицю оновлено о ${new Date().toLocaleTimeString('uk-UA')}`);
  } catch (err) {
    console.error('[Google Sheets] Помилка синхронізації з таблицею:', err.message);
  }
}

function cleanAndSortSlots(slots) {
  const map = new Map();
  for (const s of slots) {
    map.set(`${s.start}-${s.end}`, s);
  }
  return Array.from(map.values()).sort((a, b) => a.start.localeCompare(b.start));
}

// Фоновий тригер кожні 30 хвилин
setInterval(updateScheduleFromGoogleSheets, 30 * 60 * 1000);
// Первинний запуск
updateScheduleFromGoogleSheets();

// API статусу
app.get('/api/status', (req, res) => {
  const queue = (req.query.queue || '3.2').replace('-', '.');
  const day = req.query.day || 'today';

  const dayMap = day === 'tomorrow' ? scheduleCache.tomorrow : scheduleCache.today;
  const slots = dayMap[queue] || [];

  res.json({
    queue,
    day,
    slots,
    sourceUrl: scheduleCache.sourceUrl,
    lastUpdated: scheduleCache.lastUpdated || new Date().toISOString()
  });
});

// Керування темами
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

// Форма відгуків
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