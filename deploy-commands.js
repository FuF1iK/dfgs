require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Начать показывать живой скриншот страницы в этом канале')
    .addStringOption((opt) =>
      opt.setName('url').setDescription('Ссылка на страницу').setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('clicks')
        .setDescription('Текст кнопок для клика перед чтением, через запятую, например Неделя,Игроки')
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('interval')
        .setDescription('Интервал обновления в секундах (мин. 10, по умолчанию 60)')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('watchtable')
    .setDescription('Извлекать таблицу со страницы и обновлять её как текстовую таблицу')
    .addStringOption((opt) =>
      opt.setName('url').setDescription('Ссылка на страницу').setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('selector')
        .setDescription('CSS-селектор таблицы (по умолчанию первая <table> на странице)')
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('clicks')
        .setDescription('Текст кнопок для клика перед чтением, через запятую, например Неделя,Игроки')
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('interval')
        .setDescription('Интервал обновления в секундах (мин. 10, по умолчанию 60)')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('watchdata')
    .setDescription('Извлечь произвольные данные со страницы по своим селекторам и собрать таблицу')
    .addStringOption((opt) =>
      opt.setName('url').setDescription('Ссылка на страницу').setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('row_selector')
        .setDescription('CSS-селектор повторяющегося блока, например .product-card')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('columns')
        .setDescription('CSS-селекторы колонок через запятую внутри блока, например .name,.price')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('headers')
        .setDescription('Названия колонок через запятую, например Товар,Цена')
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('clicks')
        .setDescription('Текст кнопок для клика перед чтением, через запятую, например Неделя,Игроки')
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('interval')
        .setDescription('Интервал обновления в секундах (мин. 10, по умолчанию 60)')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('unwatch')
    .setDescription('Остановить обновление по ID сообщения')
    .addStringOption((opt) =>
      opt.setName('message_id').setDescription('ID сообщения с превью').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('listwatches')
    .setDescription('Показать список активных наблюдений'),
].map((c) => c.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

const GUILD_IDS = [
  '1100442923830628455',
  '1519513310519759029',
  '1171000043587784774',
];

(async () => {
  for (const guildId of GUILD_IDS) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
        { body: commands }
      );
      console.log(`✅ Команды зарегистрированы на сервере: ${guildId}`);
    } catch (err) {
      console.error(`❌ Ошибка на сервере ${guildId}:`, err.message);
    }
  }
  console.log('Готово.');
})();
