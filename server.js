const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.static('public'));

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
  let slots = [];

  // Шукаємо заголовок саме потрібної черги
  let targetCard = null;

  $('*').each((_, el) => {
    if (targetCard) return; // вже знайшли

    const text = $(el).text().trim();
    // Шукаємо точний збіг назви черги (Черга 3.2 або 3.2)
    if (text === `Черга ${targetQueue}` || text === `Черга: ${targetQueue}`) {
      // Піднімаємося вгору крок за кроком, доки не знайдемо блок картки,
      // але зупиняємося ДО того, як батько захопить інші черги (наприклад, "Черга 1.1")
      let current = $(el).parent();
      while (current.length && current[0].tagName !== 'body') {
        const parentText = current.parent().text() || '';
        // Якщо батьківський елемент вже містить інші черги — значить поточний `current` і є карткою нашої черги!
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

  if (targetCard && targetCard.length) {
    // Шукаємо інтервали тільки всередині знайденої ізольованої картки
    targetCard.find('div, li, tr').each((_, row) => {
      const rowText = $(row).text().trim();
      const match = rowText.match(/^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/);
      
      // Переконуємось, що це чистий рядок часу без вкладених інших годин
      if (match && (rowText.match(/(\d{1,2}:\d{2})/g) || []).length === 2) {
        const start = match[1];
        let end = match[2];
        if (end === '24:00') end = '23:59';

        const html = $(row).html().toLowerCase();
        
        // Ознаки відключення (блискавка, червоний колір, рожевий бейдж)
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

  // Сортуємо розклад за часом
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
    console.error('Fetch error:', err.message);
    res.status(500).json({ error: 'Помилка отримання даних', slots: [] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер працює на порту ${PORT}`));