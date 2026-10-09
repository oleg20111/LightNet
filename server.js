const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.static('public'));

const cache = new Map();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 хвилини кешу за замовчуванням

async function fetchFromBezsvitla(regionSlug, queue, day = 'today') {
  const cacheKey = `${regionSlug}_${queue}_${day}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    const url = `https://bezsvitla.com.ua/${regionSlug}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 35000 });

    // Якщо запитуємо "Завтра", шукаємо кнопку перемикання на завтра та натискаємо її
    if (day === 'tomorrow') {
      const clicked = await page.evaluate(() => {
        // Шукаємо кнопки, таби або посилання зі словами "Завтра"
        const elements = Array.from(document.querySelectorAll('button, a, div[role="tab"], div[role="button"], span'));
        const tomorrowBtn = elements.find(el => {
          const t = (el.innerText || el.textContent || '').trim().toLowerCase();
          return t === 'завтра' || t.includes('на завтра') || t.includes('план на завтра');
        });

        if (tomorrowBtn) {
          tomorrowBtn.click();
          return true;
        }
        return false;
      });

      if (clicked) {
        // Чекаємо, поки React перемалює картки
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    const result = await page.evaluate((targetQueue, targetDay) => {
      // 1. Якщо ми просили "завтра", перевіримо, чи немає заглушки "ще не оприлюднено"
      const bodyText = (document.body.innerText || '').toLowerCase();
      if (targetDay === 'tomorrow') {
        const noScheduleHints = [
          'графік на завтра очікується',
          'графік на завтра ще не оприлюднено',
          'немає графіка на завтра'
        ];
        const hasNoSchedule = noScheduleHints.some(hint => bodyText.includes(hint));
        if (hasNoSchedule) {
          return { queue: targetQueue, slots: [] };
        }
      }

      // 2. Шукаємо елемент заголовка черги
      const allHeaders = Array.from(document.querySelectorAll('*')).filter(el => {
        const t = (el.textContent || '').trim();
        return t === `Черга ${targetQueue}` || t === `Черга: ${targetQueue}`;
      });

      if (allHeaders.length === 0) {
        return { queue: targetQueue, slots: [] };
      }

      // Беремо останній знайдений заголовок (якщо на сторінці одночасно присутні блоки "сьогодні" і "завтра")
      const headerEl = allHeaders[allHeaders.length - 1];

      // 3. Піднімаємося до ізольованої картки цієї черги
      let card = headerEl.parentElement;
      while (card && card !== document.body) {
        const text = card.innerText || '';
        if (text.includes(`Черга ${targetQueue}`)) {
          const parentText = card.parentElement ? (card.parentElement.innerText || '') : '';
          if (parentText.match(/Черга\s+\d/g) && parentText.match(/Черга\s+\d/g).length > 1) {
            break;
          }
        }
        card = card.parentElement;
      }

      if (!card) {
        return { queue: targetQueue, slots: [] };
      }

      const slots = [];
      const rows = Array.from(card.querySelectorAll('div, li, tr'));

      rows.forEach(row => {
        const text = row.innerText || '';
        const timeMatch = text.match(/^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/);

        if (timeMatch && (text.match(/(\d{1,2}:\d{2})/g) || []).length === 2) {
          const start = timeMatch[1];
          let end = timeMatch[2];
          if (end === '24:00') end = '23:59';

          const html = row.innerHTML.toLowerCase();
          
          // Ознаки відключення (червоний колір, перекреслена блискавка)
          const isOff = html.includes('rgb(254') || 
                        html.includes('rgb(255') || 
                        html.includes('bg-red') || 
                        html.includes('rose') || 
                        html.includes('danger') ||
                        html.includes('polygon') || 
                        html.includes('bolt') || 
                        html.includes('m13');

          if (!slots.some(s => s.start === start && s.end === end)) {
            slots.push({
              start,
              end,
              status: isOff ? 'off' : 'on'
            });
          }
        }
      });

      slots.sort((a, b) => a.start.localeCompare(b.start));
      return { queue: targetQueue, slots };
    }, queue, day);

    const responsePayload = {
      region: regionSlug,
      queue,
      day,
      slots: result.slots || [],
      lastUpdated: new Date().toISOString()
    };

    cache.set(cacheKey, { data: responsePayload, timestamp: Date.now() });
    return responsePayload;
  } finally {
    if (browser) await browser.close();
  }
}

app.get('/api/status', async (req, res) => {
  const region = req.query.region || 'poltavska-oblast';
  const queue = req.query.queue || '3.2';
  const day = req.query.day || 'today';
  const force = req.query.force === 'true';

  if (force) {
    cache.delete(`${region}_${queue}_${day}`);
  }

  try {
    const data = await fetchFromBezsvitla(region, queue, day);
    res.json(data);
  } catch (err) {
    console.error('API Error:', err.message);
    res.status(500).json({ error: 'Не вдалося завантажити графік', slots: [] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер працює: http://localhost:${PORT}`));