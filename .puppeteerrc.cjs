const { join } = require('path');

/**
 * Вказує Puppeteer зберігати завантажений Chrome всередині папки проєкту,
 * щоб Render його не втрачав між збірками.
 */
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};