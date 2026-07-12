// Вспомогательный скрипт. Не часть самого бота — нужен только один раз,
// чтобы посмотреть реальную структуру страницы ПОСЛЕ выбора "Неделя" и
// "Игроки", и подобрать селекторы для таблицы.
//
// Запуск (в той же папке, где уже стоят зависимости бота):
//   node inspect.js
//
// После запуска появятся файлы:
//   page-dump.html — HTML страницы после клика "Неделя" + "Игроки"
//   page-dump.png  — скриншот этого состояния (на всякий случай)
//
// page-dump.html нужно прислать мне в чат — я найду в нём селекторы.

const { chromium } = require('playwright');
const fs = require('fs');

const URL = process.argv[2] || 'https://fletcher-wiki.com/players-family-stats/family/1983?server=ru7';

(async () => {
  console.log(`Открываю: ${URL}`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Анти-DDoS проверка сайта делает редирект через ~5 секунд.
  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log('Прошли проверку браузера (был автоматический редирект).');
  } catch (e) {
    console.log('Редиректа не зафиксировано — возможно, проверка уже была пройдена ранее.');
  }

  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Кликаем "Неделя"
  try {
    await page.locator('button:has-text("Неделя")').first().click({ timeout: 10000 });
    console.log('Кликнули "Неделя".');
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
  } catch (e) {
    console.log('Не нашёл кнопку "Неделя":', e.message);
  }

  // Кликаем "Игроки"
  try {
    await page.locator('button:has-text("Игроки")').first().click({ timeout: 10000 });
    console.log('Кликнули "Игроки".');
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
  } catch (e) {
    console.log('Не нашёл кнопку "Игроки":', e.message);
  }

  const html = await page.content();
  fs.writeFileSync('page-dump.html', html, 'utf-8');
  console.log('Сохранено: page-dump.html');

  await page.screenshot({ path: 'page-dump.png', fullPage: true });
  console.log('Сохранено: page-dump.png');

  const title = await page.title();
  console.log(`Заголовок страницы сейчас: "${title}"`);

  await browser.close();
  console.log('Готово. Пришлите page-dump.html в чат.');
})();
