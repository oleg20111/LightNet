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
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || '';

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

// Формування посилання CSV без помилки 404
function getDirectCsvUrl(url) {
  if (!url) return '';
  if (url.includes('/pub?') && url.includes('output=csv')) {
    return url; // Вже готовий прямий лінк експорту
  }
  const matchDoc = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (!matchDoc) return url;
  const docId = matchDoc[1];

  let gid = '0';
  const matchGid = url.match(/gid=([0-9]+)/);
  if (matchGid) gid = matchGid[1];

  return `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv&gid=${gid}`;
}

// Парсинг CSV рядків з підтримкою цитат та крапок з комою
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

// Сховище розпарсеного розкладу
// Структура: db[regionSlug][day][queue] = [{start, end, status}]
let dbSchedules = {};
let lastSyncTime = null;

// Словник зіставлення назв областей у таблиці з селектором на сайті
function matchRegionSlug(text) {
  const t = text.toLowerCase();
  if (t.includes('полтав')) return 'poltavska-oblast';
  if (t.includes('київськ')) return 'kyivska-oblast';
  if (t.includes('м. київ') || t.includes('київ місто') || t === 'київ') return 'm-kyiv';
  if (t.includes('львів')) return 'lvivska-oblast';
  if (t.includes('дніпро')) return 'dnipropetrovska-oblast';
  if (t.includes('одес')) return 'odeska-oblast';
  if (t.includes('харків')) return 'kharkivska-oblast';
  if (t.includes('вінниц')) return 'vinnytska-oblast';
  if (t.includes('черкас')) return 'cherkaska-oblast';
  if (t.includes('сум')) return 'sumska-oblast';
  if (t.includes('чернігів')) return 'chernihivska-oblast';
  if (t.includes('житомир')) return 'zhytomyrska-oblast';
  return null;
}

async function syncGoogleSheets() {
  const csvUrl = getDirectCsvUrl(GOOGLE_SHEET_URL);
  if (!csvUrl) {
    console.warn('[Google Sheets] GOOGLE_SHEET_URL не встановлено');
    return;
  }

  try {
    const response = await axios.get(csvUrl, { timeout: 15000 });
    const rows = parseCSV(response.data);

    if (!rows || rows.length < 2) return;

    const newDb = {};

    // Проходимо по рядках (починаючи з 4-го рядка, пропускаючи заголовки)
    for (const row of rows) {
      if (row.length < 5) continue;

      const rawRegion = row[0] || '';   // Колонка A (Область)
      const rawPeriod = row[1] || '';   // Колонка B (Сьогодні / Завтра)
      const rawQueue = row[3] || '';    // Колонка D (Черга 1.1 - 6.2)
      const rawSchedule = row[4] || ''; // Колонка E (Повний графік зі статусами)

      const regSlug = matchRegionSlug(rawRegion);
      if (!regSlug) continue;

      const dayKey = rawPeriod.toLowerCase().includes('завтра') ? 'tomorrow' : 'today';

      // Витягуємо номер черги "3.2" з "Черга 3.2"
      const qMatch = rawQueue.match(/([1-6]\.[1-2])/);
      if (!qMatch) continue;
      const queueKey = qMatch[1];

      // Парсимо графік: "00:00 – 17:30 [Є]; 17:30 – 20:00 [НЕМАЄ]; 23:30 – 24:00 [НЕМАЄ]"
      const slots = [];
      const parts = rawSchedule.split(';');

      for (const part of parts) {
        const item = part.trim();
        const timeMatch = item.match(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/);
        if (!timeMatch) continue;

        let start = timeMatch[1];
        let end = timeMatch[2];
        if (end === '24:00') end = '23:59';

        const isOff = item.toUpperCase().includes('[НЕМАЄ]');

        slots.push({
          start,
          end,
          status: isOff ? 'off' : 'on'
        });
      }

      slots.sort((a, b) => a.start.localeCompare(b.start));

      if (!newDb[regSlug]) newDb[regSlug] = { today: {}, tomorrow: {} };
      if (!newDb[regSlug][dayKey]) newDb[regSlug][dayKey] = {};

      newDb[regSlug][dayKey][queueKey] = slots;
    }

    dbSchedules = newDb;
    lastSyncTime = new Date().toISOString();
    console.log(`[Google Sheets] Успішно оновлено базу о ${new Date().toLocaleTimeString('uk-UA')}`);
  } catch (err) {
    console.error('[Google Sheets] Помилка синхронізації:', err.message);
  }
}

// Автоматичне оновлення кожні 30 хвилин
setInterval(syncGoogleSheets, 30 * 60 * 1000);
// Перше оновлення одразу після старту
syncGoogleSheets();

// Ендпоінт статусу для сайту
app.get('/api/status', (req, res) => {
  const region = req.query.region || 'poltavska-oblast';
  const queue = (req.query.queue || '3.2').replace('-', '.');
  const day = req.query.day || 'today';

  const regData = dbSchedules[region];
  const dayData = regData ? regData[day] : null;
  const slots = (dayData && dayData[queue]) ? dayData[queue] : [];

  res.json({
    region,
    queue,
    day,
    slots,
    sourceUrl: GOOGLE_SHEET_URL,
    lastUpdated: lastSyncTime || new Date().toISOString()
  });
});

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

// Відгуки
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