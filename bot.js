const TelegramBot = require("node-telegram-bot-api");

const BOT_TOKEN = "8747045011:AAGS7i9nSL5LWggzVab5Z2irjCz8GWCpCMk";
const CHAT_ID = "-1003635106281";
const APP_URL = "https://flowfit-sim.vercel.app";

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${CHAT_ID}&user_id=${userId}`);
    const data = await res.json();
    const status = data.result?.status;
    const isMember = ["member", "administrator", "creator"].includes(status);

    if (isMember) {
      bot.sendMessage(userId, "👋 Привіт! Ти є підписником клубу.\n\nНатисни кнопку нижче щоб розпочати симуляцію 👇", {
        reply_markup: {
          inline_keyboard: [[{
            text: "🚀 Відкрити симуляцію FlowFit",
            web_app: { url: APP_URL }
          }]]
        }
      });
    } else {
      bot.sendMessage(userId, "🔒 Симуляція доступна лише для підписників клубу CEO of Good Marketing Club.\n\nОформи підписку щоб отримати доступ 👇", {
        reply_markup: {
          inline_keyboard: [[{
            text: "Оформити підписку",
            url: "https://zanedu.com"
          }]]
        }
      });
    }
  } catch (e) {
    bot.sendMessage(userId, "Щось пішло не так. Спробуй пізніше.");
  }
});

console.log("Бот запущено!");
