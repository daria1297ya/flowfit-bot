require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const Stripe = require("stripe");

const BOT_TOKEN        = process.env.BOT_TOKEN;
const CHAT_ID          = process.env.CHAT_ID || "-1003635106281";
const APP_URL          = "https://flowfit-sim.vercel.app";
const CHANNEL_URL      = "https://t.me/+ZGRuXjL_2itiMjdi";
const STRIPE_SECRET    = process.env.STRIPE_SECRET;
const STRIPE_WH_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE_ID  = process.env.STRIPE_PRICE_ID || "price_1TR6znG53zpmJ5ujLITQBhpr";
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;

const NEW_USER_TEXT = `Вітаю тебе у боті маркетингового клубу для тих, хто будує та розвиває бренди нового покоління CEO of Good Marketing Club.

Цей клуб для:
— для маркетологів, які шукають перевірені інструменти, хочуть кар'єрно зростати та випереджати ринок;
— для підприємців, які хочуть бути в курсі актуальних маркетингових стратегій і впроваджувати нові рішення, збільшуючи прибуток;
— для тих, хто цінує ексклюзивні знання, інсайти від великих гравців і практичний контент, який можна застосувати відразу.

У клубі на тебе чекають:
— Маркетингові симуляції: запуск нового бренду, антикризовий менеджмент, покроковий запуск піар кампанії — спробуй себе у нових ролях та прокачуй навички на реальних ситуаціях;
— Особистий бренд & монетизація маркетологів, креативників та стратегів: будемо покроково вчитись, як заявляти про себе та заробляти на своєму досвіді більше;
— Case Study: покроковий розбір стратегій та рішень успішних брендів;
— How to AI: воркшопи, інструменти, промпти як зробити level-up у маркетингу за допомогою штучного інтелекту;
— Подарунки для найактивніших та постійних членів клубу: з продуктами брендів, концепти яких ми досліджуємо як приклад вау комунікації, я буду знайомити вас особисто.

Якщо ти хочеш вміти і знати більше за інших та будувати сильні, помітні та сучасні бренди — тобі точно сюди.
Приєднуйся до CEO of Good Marketing club.`;

const bot      = new TelegramBot(BOT_TOKEN, { polling: true });
const stripe   = new Stripe(STRIPE_SECRET);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app      = express();

app.post("/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WH_SECRET);
    } catch (err) {
      console.error("❌ Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (
      event.type === "checkout.session.completed" ||
      event.type === "invoice.payment_succeeded"
    ) {
      const obj = event.data.object;
      const telegramId = obj.metadata?.telegram_id;
      const email = obj.customer_email || obj.customer_details?.email || null;

      console.log(`✅ Оплата: telegram_id=${telegramId}, email=${email}`);

      if (telegramId) {
        const { error } = await supabase.from("subscribers").upsert({
          telegram_id: String(telegramId),
          email,
          subscribed_at: new Date().toISOString(),
          status: "active",
          last_nurture_day: 0,
        });
        if (error) console.error("Supabase upsert error:", error);

        const { data: welcome } = await supabase
          .from("nurture_messages")
          .select("text")
          .eq("day", 0)
          .single();

        const welcomeText = welcome?.text ||
          "🎉 Вітаємо в CEO of Good Marketing Club!\n\nТи тепер маєш повний доступ до клубу.";

        await bot.sendMessage(telegramId, welcomeText, {
          reply_markup: {
            inline_keyboard: [[
              { text: "🚀 Відкрити симуляцію", web_app: { url: APP_URL } },
              { text: "📢 Перейти в канал", url: CHANNEL_URL }
            ]],
          },
        });
      }
    }

    res.json({ received: true });
  }
);

app.use(express.json());
app.get("/", (_, res) => res.send("✅ Bot is running!"));

bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${CHAT_ID}&user_id=${userId}`
    );
    const data = await r.json();
    const status = data.result?.status;
    const isMember = ["member", "administrator", "creator"].includes(status);

    if (isMember) {
      bot.sendMessage(userId,
        "👋 Привіт! Радий тебе бачити знову.\n\nТи вже частина CEO of Good Marketing Club 🎉\n\nЩо хочеш зробити?",
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "🚀 Відкрити симуляцію", web_app: { url: APP_URL } },
              { text: "📢 Перейти в канал", url: CHANNEL_URL }
            ]],
          },
        }
      );
    } else {
      try {
        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
          success_url: `https://t.me/CEO_of_Good_Marketing_bot?start=success`,
          cancel_url: `https://t.me/CEO_of_Good_Marketing_bot`,
          metadata: { telegram_id: String(userId) },
          subscription_data: { metadata: { telegram_id: String(userId) } },
        });

        bot.sendMessage(userId, NEW_USER_TEXT, {
          reply_markup: {
            inline_keyboard: [[{
              text: "💳 Оформити підписку — €20/міс",
              url: session.url,
            }]],
          },
        });
      } catch (stripeErr) {
        console.error("Stripe session error:", stripeErr);
        bot.sendMessage(userId, "Щось пішло не так. Спробуй пізніше.");
      }
    }
  } catch (e) {
    console.error(e);
    bot.sendMessage(userId, "Щось пішло не так. Спробуй пізніше.");
  }
});

setInterval(async () => {
  try {
    const { data: subs } = await supabase
      .from("subscribers")
      .select("*")
      .eq("status", "active");

    for (const sub of subs || []) {
      const daysSince = Math.floor(
        (Date.now() - new Date(sub.subscribed_at)) / (1000 * 60 * 60 * 24)
      );
      if (sub.last_nurture_day >= daysSince) continue;

      const { data: nurtureMsg } = await supabase
        .from("nurture_messages")
        .select("text")
        .eq("day", daysSince)
        .single();

      if (nurtureMsg?.text) {
        await bot.sendMessage(sub.telegram_id, nurtureMsg.text);
        await supabase
          .from("subscribers")
          .update({ last_nurture_day: daysSince })
          .eq("telegram_id", sub.telegram_id);
        console.log(`📨 Nurture day ${daysSince} → ${sub.telegram_id}`);
      }
    }
  } catch (e) {
    console.error("Nurture scheduler error:", e);
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
console.log("✅ Бот запущено!");
