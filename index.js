require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
} = require('discord.js');
const { chromium } = require('playwright');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// watchId (= ID сообщения) -> { type, url, ..., clicks, intervalMs, channelId, messageId, timer }
const watches = new Map();
let browserInstance = null;
let contextInstance = null;

const MAX_TABLE_ROWS = 999;    // без лимита — ограничивает только MAX_DESCRIPTION_LENGTH
const MAX_COL_WIDTH = 12;      // максимум символов на ячейку
const MAX_LINE_WIDTH = 52;     // максимум символов на строку — Discord переносит длиннее
const MAX_DESCRIPTION_LENGTH = 3800;

// ---------- Проверка прав по ролям ----------

function hasPermission(interaction) {
  const allowedRoles = (process.env.ALLOWED_ROLE_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (allowedRoles.length === 0) return true; // ограничение не настроено — доступно всем
  if (!interaction.member) return false; // вызов не на сервере (например, в DM)

  return interaction.member.roles.cache.some((role) => allowedRoles.includes(role.id));
}

// ---------- Браузер ----------
// Используем ОДИН постоянный контекст (а не новый при каждом вызове), чтобы
// куки анти-бот защиты сайтов сохранялись между обновлениями и не приходилось
// каждый раз заново проходить проверку "Проверяем ваш браузер...".

async function getContext() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({ headless: true });
  }
  if (!contextInstance) {
    contextInstance = await browserInstance.newContext({ viewport: { width: 1280, height: 800 } });
  }
  return contextInstance;
}

function parseClicks(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Загружает страницу и дожидается возможного авто-редиректа анти-бот защиты.
async function gotoAndSettle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 });
  } catch (e) {
    // редиректа не было — это нормальная ситуация, просто продолжаем
  }
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
}

// Кликает по кнопкам с указанным текстом, по очереди (например ["Неделя", "Игроки"]).
async function performClicks(page, clickTexts) {
  for (const text of clickTexts) {
    try {
      await page.locator(`button:has-text("${text}")`).first().click({ timeout: 10000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
    } catch (e) {
      console.error(`Не удалось кликнуть по кнопке "${text}": ${e.message}`);
    }
  }
}

// ---------- Скриншот страницы ----------

async function screenshotPage(url, clicks = []) {
  const context = await getContext();
  const page = await context.newPage();
  try {
    await gotoAndSettle(page, url);
    await performClicks(page, clicks);
    return await page.screenshot({ fullPage: false });
  } finally {
    await page.close();
  }
}

function buildScreenshotEmbed(url, intervalSec) {
  return new EmbedBuilder()
    .setTitle('Живое превью страницы')
    .setURL(url)
    .setImage('attachment://screenshot.png')
    .setFooter({ text: `Обновляется каждые ${intervalSec} сек.` })
    .setTimestamp();
}

// ---------- Извлечение готовой <table> ----------

async function extractTable(url, selector, clicks = []) {
  const context = await getContext();
  const page = await context.newPage();
  try {
    await gotoAndSettle(page, url);
    await performClicks(page, clicks);
    const rows = await page.evaluate((sel) => {
      const table = document.querySelector(sel);
      if (!table) return null;
      return [...table.querySelectorAll('tr')].map((row) =>
        [...row.querySelectorAll('th, td')].map((cell) => cell.textContent.trim())
      );
    }, selector || 'table');
    return rows;
  } finally {
    await page.close();
  }
}

// ---------- Извлечение произвольных данных по селекторам ----------

async function extractCustomData(url, rowSelector, columnSelectors, clicks = []) {
  const context = await getContext();
  const page = await context.newPage();
  try {
    await gotoAndSettle(page, url);
    await performClicks(page, clicks);
    const rows = await page.evaluate(
      ({ rowSel, colSels }) => {
        const rowEls = [...document.querySelectorAll(rowSel)];
        return rowEls.map((rowEl) =>
          colSels.map((colSel) => {
            const sel = colSel.trim();
            const el =
              sel === '.' || sel.toLowerCase() === 'self' ? rowEl : rowEl.querySelector(sel);
            return el ? el.textContent.trim() : '';
          })
        );
      },
      { rowSel: rowSelector, colSels: columnSelectors }
    );
    return rows;
  } finally {
    await page.close();
  }
}

// ---------- Форматирование текстовой таблицы ----------

function formatTable(rows, headerRowCount = 0) {
  if (!rows || rows.length === 0) return null;

  const clip = (text, max) => (text || '').replace(/`/g, "'").slice(0, max);

  const limited = rows.slice(0, MAX_TABLE_ROWS + headerRowCount);
  const colCount = Math.max(...limited.map((r) => r.length));

  // Шаг 1: считаем натуральную ширину каждой колонки (с учётом MAX_COL_WIDTH)
  const colWidths = Array(colCount).fill(0);
  for (const row of limited) {
    row.forEach((cell, i) => {
      colWidths[i] = Math.max(colWidths[i], clip(cell, MAX_COL_WIDTH).length);
    });
  }

  // Шаг 2: если суммарная строка выходит за MAX_LINE_WIDTH — пропорционально сжимаем
  // Ширина строки = сумма ширин + (colCount - 1) * 3 знака " | "
  const separatorWidth = (colCount - 1) * 3;
  let totalContent = colWidths.reduce((a, b) => a + b, 0);
  if (totalContent + separatorWidth > MAX_LINE_WIDTH) {
    const budget = MAX_LINE_WIDTH - separatorWidth;
    // Урезаем каждую колонку пропорционально её доле в суммарной ширине
    const scale = budget / totalContent;
    for (let i = 0; i < colWidths.length; i++) {
      colWidths[i] = Math.max(i === 0 ? 2 : 1, Math.floor(colWidths[i] * scale));
    }
  }

  // Шаг 3: собираем строки
  const lines = limited.map((row) =>
    row.map((cell, i) => clip(cell, colWidths[i]).padEnd(colWidths[i] ?? 0)).join(' | ')
  );

  if (headerRowCount > 0 && lines.length > headerRowCount) {
    const separator = colWidths.map((w) => '-'.repeat(w)).join('-+-');
    lines.splice(headerRowCount, 0, separator);
  }

  let result = lines.join('\n');
  const totalDataRows = rows.length - headerRowCount;
  if (totalDataRows > MAX_TABLE_ROWS) {
    result += `\n… и ещё ${totalDataRows - MAX_TABLE_ROWS} строк`;
  }
  if (result.length > MAX_DESCRIPTION_LENGTH) {
    result = result.slice(0, MAX_DESCRIPTION_LENGTH) + '\n… (обрезано)';
  }
  return result;
}

// Разбивает массив строк таблицы на чанки, каждый из которых влезает в один embed
function splitTableIntoChunks(rows, headerRowCount = 0) {
  const header = rows.slice(0, headerRowCount);
  const data   = rows.slice(headerRowCount);
  const chunks  = [];
  let current   = [];

  for (const row of data) {
    const candidate = [...header, ...current, row];
    const text = formatTable(candidate, headerRowCount);
    if (text && ('```\n' + text + '\n```').length > MAX_DESCRIPTION_LENGTH && current.length > 0) {
      chunks.push([...header, ...current]);
      current = [row];
    } else {
      current.push(row);
    }
  }
  if (current.length > 0) chunks.push([...header, ...current]);
  return chunks;
}

function buildTableEmbeds(url, rows, intervalSec) {
  const chunks = splitTableIntoChunks(rows, 1);
  return chunks.map((chunk, i) =>
    new EmbedBuilder()
      .setTitle(chunks.length > 1 ? `Живая таблица со страницы (${i + 1}/${chunks.length})` : 'Живая таблица со страницы')
      .setURL(url)
      .setDescription('```\n' + formatTable(chunk, 1) + '\n```')
      .setFooter({ text: i === chunks.length - 1 ? `Обновляется каждые ${intervalSec} сек. • всего строк: ${rows.length - 1}` : '\u200b' })
      .setTimestamp()
  );
}

function buildDataEmbeds(url, rows, headers, intervalSec) {
  const tableRows = headers && headers.length ? [headers, ...rows] : rows;
  const headerRowCount = headers && headers.length ? 1 : 0;
  const chunks = splitTableIntoChunks(tableRows, headerRowCount);
  return chunks.map((chunk, i) =>
    new EmbedBuilder()
      .setTitle(chunks.length > 1 ? `Своя таблица со страницы (${i + 1}/${chunks.length})` : 'Своя таблица со страницы')
      .setURL(url)
      .setDescription('```\n' + formatTable(chunk, headerRowCount) + '\n```')
      .setFooter({ text: i === chunks.length - 1 ? `Обновляется каждые ${intervalSec} сек. • всего строк: ${rows.length}` : '\u200b' })
      .setTimestamp()
  );
}

// ---------- Общее обновление по таймеру ----------

async function updateWatch(watchId) {
  const watch = watches.get(watchId);
  if (!watch) return;
  try {
    const channel = await client.channels.fetch(watch.channelId);

    if (watch.type === 'screenshot') {
      const message = await channel.messages.fetch(watch.messageIds[0]);
      const buffer = await screenshotPage(watch.url, watch.clicks);
      const attachment = new AttachmentBuilder(buffer, { name: 'screenshot.png' });
      const embed = buildScreenshotEmbed(watch.url, watch.intervalMs / 1000);
      await message.edit({ embeds: [embed], files: [attachment] });
    } else if (watch.type === 'table') {
      const rows = await extractTable(watch.url, watch.selector, watch.clicks);
      if (!rows) { console.error(`Таблица не найдена при обновлении watch ${watchId}`); return; }
      const embeds = buildTableEmbeds(watch.url, rows, watch.intervalMs / 1000);
      for (let i = 0; i < embeds.length; i++) {
        if (i < watch.messageIds.length) {
          const msg = await channel.messages.fetch(watch.messageIds[i]);
          await msg.edit({ embeds: [embeds[i]], files: [] });
        } else {
          const msg = await channel.send({ embeds: [embeds[i]] });
          watch.messageIds.push(msg.id);
        }
      }
    } else if (watch.type === 'custom') {
      const rows = await extractCustomData(watch.url, watch.rowSelector, watch.columns, watch.clicks);
      if (!rows || rows.length === 0) { console.error(`Данные не найдены при обновлении watch ${watchId}`); return; }
      const embeds = buildDataEmbeds(watch.url, rows, watch.headers, watch.intervalMs / 1000);
      for (let i = 0; i < embeds.length; i++) {
        if (i < watch.messageIds.length) {
          const msg = await channel.messages.fetch(watch.messageIds[i]);
          await msg.edit({ embeds: [embeds[i]], files: [] });
        } else {
          const msg = await channel.send({ embeds: [embeds[i]] });
          watch.messageIds.push(msg.id);
        }
      }
    }
  } catch (err) {
    console.error(`Ошибка обновления watch ${watchId}:`, err.message);
  }
}

// ---------- Команды ----------

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!hasPermission(interaction)) {
    return interaction.reply({
      content: 'У вас нет прав для использования этой команды.',
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'watch') {
    const url = interaction.options.getString('url');
    const intervalSec = interaction.options.getInteger('interval') ?? 60;
    const clicks = parseClicks(interaction.options.getString('clicks'));

    if (!/^https?:\/\//i.test(url)) {
      return interaction.reply({
        content: 'Нужна полная ссылка, начинающаяся с http:// или https://',
        ephemeral: true,
      });
    }
    if (intervalSec < 10) {
      return interaction.reply({
        content: 'Минимальный интервал — 10 секунд (иначе можно попасть на rate limit Discord).',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      const buffer = await screenshotPage(url, clicks);
      const attachment = new AttachmentBuilder(buffer, { name: 'screenshot.png' });
      const embed = buildScreenshotEmbed(url, intervalSec);

      const message = await interaction.editReply({ embeds: [embed], files: [attachment] });

      const intervalMs = intervalSec * 1000;
      const watchId = message.id;
      const timer = setInterval(() => updateWatch(watchId), intervalMs);
      watches.set(watchId, {
        type: 'screenshot',
        url,
        clicks,
        intervalMs,
        channelId: message.channelId,
        messageIds: [message.id],
        timer,
      });
    } catch (err) {
      console.error(err);
      await interaction.editReply('Не удалось загрузить страницу. Проверьте ссылку и доступность сайта.');
    }
  }

  if (interaction.commandName === 'watchtable') {
    const url = interaction.options.getString('url');
    const selector = interaction.options.getString('selector') || 'table';
    const intervalSec = interaction.options.getInteger('interval') ?? 60;
    const clicks = parseClicks(interaction.options.getString('clicks'));

    if (!/^https?:\/\//i.test(url)) {
      return interaction.reply({
        content: 'Нужна полная ссылка, начинающаяся с http:// или https://',
        ephemeral: true,
      });
    }
    if (intervalSec < 10) {
      return interaction.reply({
        content: 'Минимальный интервал — 10 секунд (иначе можно попасть на rate limit Discord).',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      const rows = await extractTable(url, selector, clicks);
      if (!rows) {
        return interaction.editReply(
          `Не нашёл таблицу по селектору \`${selector}\` на этой странице. Попробуйте указать другой селектор параметром \`selector\`, проверить \`clicks\`, либо используйте /watchdata.`
        );
      }

      const embeds = buildTableEmbeds(url, rows, intervalSec);
      const firstMessage = await interaction.editReply({ embeds: [embeds[0]] });
      const messageIds = [firstMessage.id];
      for (let i = 1; i < embeds.length; i++) {
        const msg = await interaction.channel.send({ embeds: [embeds[i]] });
        messageIds.push(msg.id);
      }

      const intervalMs = intervalSec * 1000;
      const watchId = firstMessage.id;
      const timer = setInterval(() => updateWatch(watchId), intervalMs);
      watches.set(watchId, {
        type: 'table',
        url,
        selector,
        clicks,
        intervalMs,
        channelId: firstMessage.channelId,
        messageIds,
        timer,
      });
    } catch (err) {
      console.error(err);
      await interaction.editReply('Не удалось загрузить страницу или разобрать таблицу. Проверьте ссылку и селектор.');
    }
  }

  if (interaction.commandName === 'watchdata') {
    const url = interaction.options.getString('url');
    const rowSelector = interaction.options.getString('row_selector');
    const columnsRaw = interaction.options.getString('columns');
    const headersRaw = interaction.options.getString('headers');
    const intervalSec = interaction.options.getInteger('interval') ?? 60;
    const clicks = parseClicks(interaction.options.getString('clicks'));

    if (!/^https?:\/\//i.test(url)) {
      return interaction.reply({
        content: 'Нужна полная ссылка, начинающаяся с http:// или https://',
        ephemeral: true,
      });
    }
    if (intervalSec < 10) {
      return interaction.reply({
        content: 'Минимальный интервал — 10 секунд (иначе можно попасть на rate limit Discord).',
        ephemeral: true,
      });
    }

    const columns = columnsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const headers = headersRaw
      ? headersRaw.split(',').map((s) => s.trim())
      : null;

    if (headers && headers.length !== columns.length) {
      return interaction.reply({
        content: `Количество заголовков (${headers.length}) не совпадает с количеством колонок (${columns.length}).`,
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      const rows = await extractCustomData(url, rowSelector, columns, clicks);
      if (!rows || rows.length === 0) {
        return interaction.editReply(
          `Не нашёл элементов по селектору \`${rowSelector}\` на этой странице. Проверьте селектор и \`clicks\`.`
        );
      }

      const embeds = buildDataEmbeds(url, rows, headers, intervalSec);
      const firstMessage = await interaction.editReply({ embeds: [embeds[0]] });
      const messageIds = [firstMessage.id];
      for (let i = 1; i < embeds.length; i++) {
        const msg = await interaction.channel.send({ embeds: [embeds[i]] });
        messageIds.push(msg.id);
      }

      const intervalMs = intervalSec * 1000;
      const watchId = firstMessage.id;
      const timer = setInterval(() => updateWatch(watchId), intervalMs);
      watches.set(watchId, {
        type: 'custom',
        url,
        rowSelector,
        columns,
        headers,
        clicks,
        intervalMs,
        channelId: firstMessage.channelId,
        messageIds,
        timer,
      });
    } catch (err) {
      console.error(err);
      await interaction.editReply('Не удалось загрузить страницу или извлечь данные. Проверьте ссылку и селекторы.');
    }
  }

  if (interaction.commandName === 'unwatch') {
    const messageId = interaction.options.getString('message_id');
    const watch = watches.get(messageId);
    if (!watch) {
      return interaction.reply({
        content: 'Не нахожу такое наблюдение (возможно, бот перезапускался — состояние не сохраняется между перезапусками).',
        ephemeral: true,
      });
    }
    clearInterval(watch.timer);
    watches.delete(messageId);
    await interaction.reply({ content: 'Обновление остановлено.', ephemeral: true });
  }

  if (interaction.commandName === 'listwatches') {
    if (watches.size === 0) {
      return interaction.reply({ content: 'Сейчас нет активных наблюдений.', ephemeral: true });
    }
    const lines = [...watches.entries()].map(
      ([id, w]) => `• \`${id}\` [${w.type}] — ${w.url} (каждые ${w.intervalMs / 1000} сек.)`
    );
    await interaction.reply({ content: lines.join('\n'), ephemeral: true });
  }
});

client.once('ready', () => {
  console.log(`Бот запущен как ${client.user.tag}`);
});

process.on('SIGINT', async () => {
  for (const watch of watches.values()) clearInterval(watch.timer);
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
