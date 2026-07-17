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
bot.telegram.callApi('deleteMyCommands', { scope: JSON.stringify({ type: 'all_group_chats' }) })
  .catch(e => console.error('deleteMyCommands groups error:', e.message));
bot.telegram.callApi('deleteMyCommands', { scope: JSON.stringify({ type: 'all_supergroups' }) })
  .catch(e => console.error('deleteMyCommands supergroups error:', e.message));

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
