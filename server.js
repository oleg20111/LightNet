const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PRESETS_FILE = path.join(__dirname, 'presets.json');
const FEEDBACKS_FILE = path.join(__dirname, 'feedbacks.json');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

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
    const data = fs.readFileSync(PRESETS_FILE, 'utf-8');
    return JSON.parse(data);
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
    const data = fs.readFileSync(FEEDBACKS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

function saveFeedbacks(feedbacks) {
  fs.writeFileSync(FEEDBACKS_FILE, JSON.stringify(feedbacks, null, 2), 'utf-8');
}

// Публічні пресети
app.get('/api/presets', (req, res) => {
  res.json(getPresets());
});

// Сторінка адмінки
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Авторизація адміна
app.post('/api/admin/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true, presets: getPresets() });
  }
  return res.status(401).json({ error: 'Невірний пароль адміністратора' });
});

// Збереження пресетів
app.post('/api/admin/presets', (req, res) => {
  const { password, presets } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Доступ заборонено' });
  }
  if (!Array.isArray(presets)) {
    return res.status(400).json({ error: 'Некоректний формат списку' });
  }
  try {
    savePresets(presets);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Помилка збереження файлу пресетів' });
  }
});

// Відправка відгуку
app.post('/api/feedback', (req, res) => {
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

  res.json({ success: true, message: 'Дякуємо за ваш відгук!' });
});

// Отримання відгуків в адмінці
app.post('/api/admin/feedbacks', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Доступ заборонено' });
  }
  res.json({ feedbacks: getFeedbacks() });
});

// Парсинг графіків
const cache = new Map();
const CACHE_TTL_MS = 2 * 60 * 1000;

async function fetchScheduleData(regionSlug, targetQueue, day = 'today') {
  const cacheKey = `${regionSlug}_${targetQueue}_${day}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const url = `https://bezsvitla.com.ua/${regionSlug}`;
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8'
    },
    timeout: 15000
  });

  const $ = cheerio.load(response.data);
  let targetCard = null;

  $('*').each((_, el) => {
    if (targetCard) return;
    const text = $(el).text().trim();
    if (text === `Черга ${targetQueue}` || text === `Черга: ${targetQueue}`) {
      let current = $(el).parent();
      while (current.length && current[0].tagName !== 'body') {
        const parentText = current.parent().text() || '';
        const queueMatches = parentText.match(/Черга\s+\d/g) || [];
        if (queueMatches.length > 1) {
          targetCard = current;
          break;
        }
        current = current.parent();
      }
      if (!targetCard) targetCard = current;
    }
  });

  let slots = [];
  if (targetCard && targetCard.length) {
    targetCard.find('div, li, tr').each((_, row) => {
      const rowText = $(row).text().trim();
      const match = rowText.match(/^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/);
      if (match && (rowText.match(/(\d{1,2}:\d{2})/g) || []).length === 2) {
        const start = match[1];
        let end = match[2];
        if (end === '24:00') end = '23:59';

        const html = $(row).html().toLowerCase();
        const isOff = html.includes('rgb(254') || 
                      html.includes('rgb(255') || 
                      html.includes('rose') || 
                      html.includes('danger') || 
                      html.includes('polygon') || 
                      html.includes('bolt') ||
                      html.includes('m13');

        if (!slots.some(s => s.start === start && s.end === end)) {
          slots.push({ start, end, status: isOff ? 'off' : 'on' });
        }
      }
    });
  }

  slots.sort((a, b) => a.start.localeCompare(b.start));

  const result = {
    region: regionSlug,
    queue: targetQueue,
    day,
    slots,
    lastUpdated: new Date().toISOString()
  };

  cache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

app.get('/api/status', async (req, res) => {
  const region = req.query.region || 'poltavska-oblast';
  const queue = req.query.queue || '3.2';
  const day = req.query.day || 'today';

  try {
    const data = await fetchScheduleData(region, queue, day);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Помилка отримання даних', slots: [] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LightNet запущено на порту ${PORT}`));