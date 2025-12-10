// pages/api/create-payment-intent.js
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2022-11-15',
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { orderId, priceId } = req.body;

    if (!orderId || !priceId) {
      return res.status(400).json({
        errorCode: 'MISSING_FIELDS',
        message: '缺少 orderId 或 priceId',
      });
    }

    // 1）确认订单存在
    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('order_id', orderId)
      .single();

    if (error || !order) {
      console.error('❌ 未找到订单：', error);
      return res.status(404).json({ error: 'Order not found' });
    }

    // 2）创建 Stripe Checkout Session
    const frontendBaseUrl = process.env.FRONTEND_BASE_URL;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'], // 以后要开通微信/支付宝再加
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      customer_email: order.email || undefined,
      metadata: {
        orderId,
      },
      success_url: `${frontendBaseUrl}/booking?step=5&orderId=${orderId}`,
      cancel_url: `${frontendBaseUrl}/booking?step=4&orderId=${orderId}&cancel=1`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('❌ create-payment-intent 出错：', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
