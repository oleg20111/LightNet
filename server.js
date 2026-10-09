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

  // 1. Проверяем данные Next.js
  const nextDataScript = $('#__NEXT_DATA__').html();
  if (nextDataScript) {
    try {
      const nextData = JSON.parse(nextDataScript);
      const pageProps = nextData.props?.pageProps || {};
      
      // Ищем массив очередей в свойствах страницы
      const queuesData = pageProps.schedules || pageProps.data || pageProps.regionData?.queues || [];
      
      // Ищем нужный день и очередь
      const queueObj = Array.isArray(queuesData) 
        ? queuesData.find(q => (q.name || q.queue || '').includes(targetQueue))
        : null;

      if (queueObj && queueObj.intervals) {
        slots = queueObj.intervals.map(i => ({
          start: i.start,
          end: i.end === '24:00' ? '23:59' : i.end,
          status: i.type === 'outage' || i.isOff || i.status === 'off' ? 'off' : 'on'
        }));
      }
    } catch (e) {
      console.warn('Next.js parse error, fallback to HTML parser');
    }
  }

  // 2. Резервный HTML-парсер (если структура поменялась)
  if (slots.length === 0) {
    // Ищем карточку с чергой
    $('*').each((_, el) => {
      const text = $(el).text().trim();
      if (text === `Черга ${targetQueue}` || text === `Черга: ${targetQueue}`) {
        const card = $(el).closest('div[class*="rounded"], div[class*="border"], div[class*="card"]');
        if (card.length) {
          card.find('div, tr, li').each((__, row) => {
            const rowText = $(row).text().trim();
            const match = rowText.match(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/);
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
      }
    });
  }

  // Если запрашивали завтра, а на сайте пока нет графика на завтра
  if (day === 'tomorrow' && slots.length === 0) {
    slots = [];
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
    console.error('Fetch error:', err.message);
    res.status(500).json({ error: 'Помилка отримання даних', slots: [] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер працює на порту ${PORT}`));