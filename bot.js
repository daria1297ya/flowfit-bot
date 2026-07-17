const { Telegraf } = require('telegraf');
const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

// ── Init ──────────────────────────────────────────────────────────────────────
const bot    = new Telegraf(process.env.BOT_TOKEN);
const stripe = new Stripe(process.env.STRIPE_SECRET);
const supa   = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const app    = express();

const CHAT_ID = process.env.CHAT_ID;
const APP_URL = process.env.APP_URL;

// ── Helper: перевірити чи є ще місця за пільговою ціною ───────────────────────
const EARLY_BIRD_LIMIT  = 40;
const EARLY_BIRD_COUPON = 'FIRST40';

async function isEarlyBirdAvailable() {
  const { count, error } = await supa
    .from('subscribers')
    .select('*', { count: 'exact', head: true });

  if (error) {
    console.error('Error counting subscribers:', error.message);
    return false; // у разі помилки краще не давати знижку, ніж зламати оплату
  }

  return (count || 0) < EARLY_BIRD_LIMIT;
}

// ── Helper: створити Stripe посилання для юзера ───────────────────────────────
async function createPaymentLink(telegramId) {
  const earlyBird = await isEarlyBirdAvailable();

  const sessionParams = {
    mode: 'subscription',
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${APP_URL}?paid=1`,
    cancel_url:  `${APP_URL}?paid=0`,
    metadata: { telegram_id: String(telegramId) }
  };

  if (earlyBird) {
    // Спробуємо з купоном, якщо не вийде — повна ціна
    try {
      const sessionWithCoupon = await stripe.checkout.sessions.create({
        ...sessionParams,
        discounts: [{ coupon: EARLY_BIRD_COUPON }]
      });
      return sessionWithCoupon.url;
    } catch (err) {
      console.error(`Coupon error (${EARLY_BIRD_COUPON}), falling back to full price:`, err.message);
    }
  }

  // Повна ціна (без купону)
  const session = await stripe.checkout.sessions.create(sessionParams);
  return session.url;
}

// ── /start ────────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const telegramId = String(ctx.from.id);
  const username   = ctx.from.username || '';
  const payload    = ctx.startPayload; // текст після ?start=

  // ── Deep-link для доступу до симуляції (з закріпленого поста в групі) ───────
  if (payload === 'simulation') {
    return ctx.reply('🚀 Натисни кнопку щоб відкрити маркетингову симуляцію:', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🚀 Відкрити симуляцію', web_app: { url: APP_URL } }
        ]]
      }
    });
  }

  // Перевіряємо чи вже підписник
  const { data: subscriber } = await supa
    .from('subscribers')
    .select('telegram_id')
    .eq('telegram_id', telegramId)
    .eq('active', true)
    .single();

  if (subscriber) {
    return ctx.reply('👋 Ти вже учасник CEO of Good Marketing Club! Перевір групу — там весь контент.');
  }

  // Зберігаємо ліда
  await supa.from('leads').upsert(
    { telegram_id: telegramId, username, joined_at: new Date().toISOString(), converted: false },
    { onConflict: 'telegram_id', ignoreDuplicates: true }
  );

  // Отримуємо велком-текст з Supabase
  const { data: msg } = await supa
    .from('nurture_messages')
    .select('text, button_text')
    .eq('type', 'lead')
    .eq('days_after', 0)
    .eq('is_active', true)
    .single();

  const text       = msg?.text        || 'Вітаємо у CEO of Good Marketing Club!';
  const buttonText = msg?.button_text || 'Стати учасником клубу';

  // Створюємо персональне Stripe посилання з telegram_id
  try {
    const paymentUrl = await createPaymentLink(telegramId);

    await ctx.reply(text, {
      reply_markup: {
        inline_keyboard: [[
          { text: buttonText, url: paymentUrl }
        ]]
      }
    });
  } catch (err) {
    console.error('Stripe error:', err.message);
    await ctx.reply(text);
  }
});


// ── /cancel — скасування підписки ────────────────────────────────────────────
bot.command('cancel', async (ctx) => {
  const telegramId = String(ctx.from.id);

  const { data: subscriber } = await supa
    .from('subscribers')
    .select('telegram_id, stripe_subscription_id')
    .eq('telegram_id', telegramId)
    .eq('active', true)
    .single();

  if (!subscriber) {
    return ctx.reply('❌ У тебе немає активної підписки.');
  }

  if (!subscriber.stripe_subscription_id) {
    return ctx.reply('⚠️ Не вдалось знайти підписку. Напиши нам напряму для скасування.');
  }

  await ctx.reply(
    '⚠️ Ти справді хочеш скасувати підписку?\n\nДоступ до групи буде закрито в кінці поточного оплаченого місяця.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Так, скасувати', callback_data: 'cancel_confirm' },
          { text: '❌ Ні, залишитись', callback_data: 'cancel_abort' }
        ]]
      }
    }
  );
});

// ── Callbacks для скасування ──────────────────────────────────────────────────
bot.action('cancel_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = String(ctx.from.id);

  const { data: subscriber } = await supa
    .from('subscribers')
    .select('stripe_subscription_id')
    .eq('telegram_id', telegramId)
    .eq('active', true)
    .single();

  if (!subscriber?.stripe_subscription_id) {
    return ctx.editMessageText('⚠️ Не вдалось знайти підписку. Напиши нам напряму.');
  }

  try {
    // cancel_at_period_end: true — доступ зберігається до кінця місяця
    await stripe.subscriptions.update(subscriber.stripe_subscription_id, {
      cancel_at_period_end: true
    });

    await supa.from('subscribers')
      .update({ status: 'cancelling' })
      .eq('telegram_id', telegramId);

    await ctx.editMessageText(
      '😔 Підписку скасовано.\n\nТи залишаєшся в групі до кінця поточного оплаченого місяця. Після цього доступ буде автоматично закрито.\n\nЯкщо передумаєш — напиши /start щоб підписатись знову.'
    );

    console.log(`[CANCEL] Subscription cancelled for ${telegramId}`);
  } catch (err) {
    console.error('[CANCEL ERROR]', err.message);
    await ctx.editMessageText('⚠️ Сталась помилка. Спробуй ще раз або напиши нам напряму.');
  }
});

bot.action('cancel_abort', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('✅ Підписку збережено! Радий що ти залишаєшся 🙌');
});

// ── Stripe Webhook ────────────────────────────────────────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── Успішна оплата ──────────────────────────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session    = event.data.object;
    const telegramId = session.metadata?.telegram_id;

    if (!telegramId) {
      console.error('No telegram_id in session metadata');
      return res.json({ received: true });
    }

    // Оновлюємо ліда
    const { error: leadError } = await supa.from('leads')
      .update({ converted: true })
      .eq('telegram_id', String(telegramId));

    if (leadError) {
      console.error('[LEAD UPDATE ERROR]', leadError.message);
    }

    // Отримуємо email та subscription_id з сесії
    const customerEmail      = session.customer_details?.email || null;
    const subscriptionId     = session.subscription || null;

    // Додаємо в підписників
    const { error: upsertError } = await supa.from('subscribers').upsert(
      {
        telegram_id:            String(telegramId),
        stripe_customer_id:     session.customer,
        stripe_subscription_id: subscriptionId,
        email:                  customerEmail,
        paid_at:                new Date().toISOString(),
        subscribed_at:          new Date().toISOString(),
        active:                 true,
        status:                 'active'
      },
      { onConflict: 'telegram_id' }
    );

    if (upsertError) {
      console.error('[SUBSCRIBER UPSERT ERROR]', upsertError.message, upsertError.details, upsertError.hint);
    } else {
      console.log(`[SUBSCRIBER SAVED] telegram_id: ${telegramId}`);
    }

    // Генеруємо одноразове посилання в групу (діє 24 год)
    try {
      const invite = await bot.telegram.createChatInviteLink(CHAT_ID, {
        member_limit: 1,
        expire_date:  Math.floor(Date.now() / 1000) + 86400
      });

      await bot.telegram.sendMessage(
        telegramId,
        `🎉 Оплата успішна! Ласкаво просимо до CEO of Good Marketing Club!\n\nОсь твоє посилання для входу в групу:\n${invite.invite_link}\n\n⏳ Посилання діє 24 години.`
      );

      console.log(`[PAYMENT] New subscriber: ${telegramId}`);
    } catch (err) {
      console.error('Error sending invite:', err.message);
    }
  }

  // ── Підписку скасовано ──────────────────────────────────────────────────────
  if (event.type === 'customer.subscription.deleted') {
    const customerId = event.data.object.customer;

    const { data: subscriber } = await supa
      .from('subscribers')
      .select('telegram_id')
      .eq('stripe_customer_id', customerId)
      .single();

    if (subscriber) {
      const telegramId = subscriber.telegram_id;

      try {
        await bot.telegram.banChatMember(CHAT_ID, telegramId);
        await bot.telegram.unbanChatMember(CHAT_ID, telegramId);
      } catch (err) {
        console.error('Error removing member:', err.message);
      }

      await supa.from('subscribers')
        .update({ active: false, cancelled_at: new Date().toISOString() })
        .eq('telegram_id', telegramId);

      try {
        await bot.telegram.sendMessage(
          telegramId,
          '😔 Твою підписку скасовано. Доступ до групи закрито.\n\nЯкщо захочеш повернутись — напиши /start і підпишись знову.'
        );
      } catch (err) {
        console.error('Error notifying user:', err.message);
      }
    }
  }

  // ── Підписка завершилась (cancel_at_period_end спрацював) ─────────────────
  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;

    // Якщо статус став canceled або підписка завершилась
    if (sub.status === 'canceled' || (sub.cancel_at_period_end && sub.canceled_at)) {
      const customerId = sub.customer;

      const { data: subscriber } = await supa
        .from('subscribers')
        .select('telegram_id')
        .eq('stripe_customer_id', customerId)
        .single();

      if (subscriber) {
        const telegramId = subscriber.telegram_id;

        try {
          await bot.telegram.banChatMember(CHAT_ID, telegramId);
          await bot.telegram.unbanChatMember(CHAT_ID, telegramId);
        } catch (err) {
          console.error('Error removing member:', err.message);
        }

        await supa.from('subscribers')
          .update({ active: false, status: 'cancelled', cancelled_at: new Date().toISOString() })
          .eq('telegram_id', telegramId);

        try {
          await bot.telegram.sendMessage(
            telegramId,
            '😔 Твій оплачений період завершився. Доступ до групи закрито.\n\nЯкщо захочеш повернутись — напиши /start і підпишись знову. Будемо раді! 🙌'
          );
        } catch (err) {
          console.error('Error notifying user:', err.message);
        }

        console.log(`[CANCEL] Access removed for ${telegramId}`);
      }
    }
  }

  res.json({ received: true });
});

// ── Nurture Cron — щодня о 10:00 ─────────────────────────────────────────────
cron.schedule('0 10 * * *', async () => {
  console.log('[CRON] Running nurture job...');

  const now = new Date();

  const { data: leads, error } = await supa
    .from('leads')
    .select('*')
    .eq('converted', false);

  if (error) {
    console.error('[CRON] Error fetching leads:', error.message);
    return;
  }

  for (const lead of leads || []) {
    const joinedAt = new Date(lead.joined_at);
    const daysDiff = Math.floor((now - joinedAt) / (1000 * 60 * 60 * 24));

    if (![1, 3, 7].includes(daysDiff)) continue;

    const { data: msg } = await supa
      .from('nurture_messages')
      .select('text, button_text')
      .eq('type', 'lead')
      .eq('days_after', daysDiff)
      .eq('is_active', true)
      .single();

    if (!msg?.text) continue;

    // Створюємо свіже персональне посилання для оплати
    try {
      const paymentUrl = await createPaymentLink(lead.telegram_id);

      await bot.telegram.sendMessage(lead.telegram_id, msg.text, {
        reply_markup: {
          inline_keyboard: [[
            { text: msg.button_text || 'Стати учасником клубу', url: paymentUrl }
          ]]
        }
      });

      console.log(`[CRON] Sent day ${daysDiff} nurture to ${lead.telegram_id}`);
    } catch (err) {
      console.error(`[CRON] Error sending to ${lead.telegram_id}:`, err.message);
    }
  }

  console.log('[CRON] Done.');
});


// ── Random Coffee ─────────────────────────────────────────────────────────────

// Перевірка чи це парна п'ятниця (раз на 2 тижні)
function isCoffeeFriday() {
  const now = new Date();
  const start = new Date('2026-07-17'); // перша п'ятниця відліку
  const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  return diffDays % 14 === 0;
}

// П'ятниця о 10:00 — питаємо хто бере участь
cron.schedule('0 10 * * 5', async () => {
  if (!isCoffeeFriday()) return;
  console.log('[COFFEE] Sending invites...');

  // Створюємо нову сесію
  const weekStart = new Date().toISOString().split('T')[0];
  const { data: session, error: sessionError } = await supa
    .from('coffee_sessions')
    .insert({ week_start: weekStart })
    .select()
    .single();

  if (sessionError) {
    console.error('[COFFEE] Error creating session:', sessionError.message);
    return;
  }

  // Беремо всіх активних підписників
  const { data: subscribers } = await supa
    .from('subscribers')
    .select('telegram_id')
    .eq('active', true);

  for (const sub of subscribers || []) {
    // Додаємо як учасника з відповіддю null
    await supa.from('coffee_participants').insert({
      session_id: session.id,
      telegram_id: sub.telegram_id,
      response: null
    });

    try {
      await bot.telegram.sendMessage(
        sub.telegram_id,
        '☕ Random Coffee цього тижня!

Хочеш познайомитись з кимось із CEO of Good Marketing Club особисто?

У неділю ми складемо пари і ти отримаєш контакт партнера для кавової зустрічі 🙂',
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Так, хочу познайомитись', callback_data: `coffee_yes_${session.id}` },
              { text: '⏭ Цього разу пропускаю', callback_data: `coffee_no_${session.id}` }
            ]]
          }
        }
      );
    } catch (err) {
      console.error(`[COFFEE] Error sending to ${sub.telegram_id}:`, err.message);
    }
  }

  console.log('[COFFEE] Invites sent.');
});

// Callback — відповідь на запрошення
bot.action(/^coffee_(yes|no)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const response = ctx.match[1];
  const sessionId = parseInt(ctx.match[2]);
  const telegramId = String(ctx.from.id);

  await supa.from('coffee_participants')
    .update({ response })
    .eq('session_id', sessionId)
    .eq('telegram_id', telegramId);

  if (response === 'yes') {
    await ctx.editMessageText('✅ Чудово! У неділю о 18:00 ти отримаєш контакт партнера для зустрічі ☕');
  } else {
    await ctx.editMessageText('⏭ Окей, наступного разу! Random Coffee буде знову через 2 тижні 🙂');
  }
});

// Неділя о 18:00 — складаємо пари
cron.schedule('0 18 * * 0', async () => {
  console.log('[COFFEE] Matching pairs...');

  // Знаходимо останню сесію
  const { data: session } = await supa
    .from('coffee_sessions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!session) return;

  // Перевіряємо чи ця неділя є наступною після coffee friday
  const weekStart = new Date(session.week_start);
  const now = new Date();
  const diffDays = Math.floor((now - weekStart) / (1000 * 60 * 60 * 24));
  if (diffDays > 3) return; // якщо сесія старіша ніж 3 дні — пропускаємо

  // Беремо всіх хто сказав "yes"
  const { data: participants } = await supa
    .from('coffee_participants')
    .select('telegram_id')
    .eq('session_id', session.id)
    .eq('response', 'yes');

  if (!participants || participants.length < 2) {
    console.log('[COFFEE] Not enough participants:', participants?.length || 0);
    return;
  }

  // Перемішуємо випадково
  const shuffled = participants.sort(() => Math.random() - 0.5);

  // Складаємо пари
  const pairs = [];
  for (let i = 0; i < shuffled.length - 1; i += 2) {
    pairs.push([shuffled[i].telegram_id, shuffled[i + 1].telegram_id]);
  }

  // Якщо непарна кількість — остання людина пропускає цей раз
  if (shuffled.length % 2 !== 0) {
    const skipped = shuffled[shuffled.length - 1].telegram_id;
    try {
      await bot.telegram.sendMessage(
        skipped,
        '😔 Цього разу кількість учасників була непарною і тобі не дісталась пара. Наступного разу обов'язково! ☕'
      );
    } catch (err) {
      console.error(`[COFFEE] Error notifying skipped user:`, err.message);
    }
  }

  // Надсилаємо повідомлення кожній парі
  for (const [id1, id2] of pairs) {
    // Отримуємо username партнерів
    const { data: sub1 } = await supa
      .from('subscribers')
      .select('telegram_username')
      .eq('telegram_id', id1)
      .single();

    const { data: sub2 } = await supa
      .from('subscribers')
      .select('telegram_username')
      .eq('telegram_id', id2)
      .single();

    const username1 = sub1?.telegram_username ? `@${sub1.telegram_username}` : `tg://user?id=${id1}`;
    const username2 = sub2?.telegram_username ? `@${sub2.telegram_username}` : `tg://user?id=${id2}`;

    // Зберігаємо пару в БД
    await supa.from('coffee_participants')
      .update({ partner_id: id2 })
      .eq('session_id', session.id)
      .eq('telegram_id', id1);

    await supa.from('coffee_participants')
      .update({ partner_id: id1 })
      .eq('session_id', session.id)
      .eq('telegram_id', id2);

    // Пишемо кожному
    try {
      await bot.telegram.sendMessage(
        id1,
        `☕ Твоя пара для Random Coffee — ${username2}!\n\nНапиши їй/йому і домовтесь про зустріч протягом тижня. Приємного знайомства! 🙌`
      );
    } catch (err) {
      console.error(`[COFFEE] Error sending match to ${id1}:`, err.message);
    }

    try {
      await bot.telegram.sendMessage(
        id2,
        `☕ Твоя пара для Random Coffee — ${username1}!\n\nНапиши їй/йому і домовтесь про зустріч протягом тижня. Приємного знайомства! 🙌`
      );
    } catch (err) {
      console.error(`[COFFEE] Error sending match to ${id2}:`, err.message);
    }

    console.log(`[COFFEE] Matched: ${id1} <-> ${id2}`);
  }

  console.log('[COFFEE] Matching done.');
});

// Через 7 днів після неділі (наступна неділя о 18:00) — питаємо чи відбулась зустріч
cron.schedule('0 18 * * 0', async () => {
  console.log('[COFFEE] Checking meetings...');

  // Знаходимо сесію 7-9 днів тому
  const { data: sessions } = await supa
    .from('coffee_sessions')
    .select('*')
    .order('created_at', { ascending: false });

  const now = new Date();
  const oldSession = sessions?.find(s => {
    const diffDays = Math.floor((now - new Date(s.week_start)) / (1000 * 60 * 60 * 24));
    return diffDays >= 7 && diffDays <= 10;
  });

  if (!oldSession) return;

  // Беремо всіх хто мав зустріч (є partner_id)
  const { data: participants } = await supa
    .from('coffee_participants')
    .select('telegram_id')
    .eq('session_id', oldSession.id)
    .not('partner_id', 'is', null)
    .is('meeting_happened', null);

  for (const p of participants || []) {
    try {
      await bot.telegram.sendMessage(
        p.telegram_id,
        '☕ Як пройшла твоя Random Coffee зустріч?',
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Так, зустрілись!', callback_data: `coffee_met_yes_${oldSession.id}` },
              { text: '❌ Не вийшло', callback_data: `coffee_met_no_${oldSession.id}` }
            ]]
          }
        }
      );
    } catch (err) {
      console.error(`[COFFEE] Error sending followup to ${p.telegram_id}:`, err.message);
    }
  }
});

// Callback — чи відбулась зустріч
bot.action(/^coffee_met_(yes|no)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const happened = ctx.match[1] === 'yes';
  const sessionId = parseInt(ctx.match[2]);
  const telegramId = String(ctx.from.id);

  await supa.from('coffee_participants')
    .update({ meeting_happened: happened })
    .eq('session_id', sessionId)
    .eq('telegram_id', telegramId);

  if (happened) {
    await ctx.editMessageText('🎉 Чудово! Радий що зустріч відбулась. До наступного Random Coffee! ☕');
  } else {
    await ctx.editMessageText('😔 Шкода. Наступного разу обов'язково вийде! ☕');
  }
});

// /coffee — статистика зустрічей
bot.command('coffee', async (ctx) => {
  const telegramId = String(ctx.from.id);

  const { data, error } = await supa
    .from('coffee_participants')
    .select('meeting_happened')
    .eq('telegram_id', telegramId)
    .eq('meeting_happened', true);

  if (error) {
    return ctx.reply('⚠️ Не вдалось отримати статистику.');
  }

  const count = data?.length || 0;

  if (count === 0) {
    return ctx.reply('☕ Ти ще не мав Random Coffee зустрічей.\n\nНаступна можливість буде в найближчу п\'ятницю!');
  }

  await ctx.reply(`☕ Твої Random Coffee зустрічі: *${count}*\n\nКожна зустріч — це нове знайомство і можливість! 🙌`, {
    parse_mode: 'Markdown'
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

bot.launch();
console.log('Bot started');

// Встановлюємо команди тільки для приватних чатів
bot.telegram.setMyCommands(
  [
    { command: 'start',  description: 'Почати / Підписатись' },
    { command: 'cancel', description: 'Скасувати підписку' }
  ],
  { scope: { type: 'all_private_chats' } }
).catch(e => console.error('setMyCommands error:', e.message));

// Прибираємо команди з групових чатів
const scopesToClear = [
  { type: 'all_group_chats' },
  { type: 'all_supergroups' },
  { type: 'chat', chat_id: CHAT_ID },
  { type: 'default' }
];

for (const scope of scopesToClear) {
  bot.telegram.deleteMyCommands({ scope })
    .then(() => console.log(`[COMMANDS] Cleared for scope: ${scope.type}`))
    .catch(e => console.error(`[COMMANDS] Error clearing ${scope.type}:`, e.message));
}

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
