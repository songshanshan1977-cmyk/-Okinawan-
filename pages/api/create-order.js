// pages/api/create-order.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // ⚠️ 服务端才能用
);

// 订单号生成：ORD-20251209-随机6位数
function generateOrderId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `ORD-${date}-${rand}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      car_model_id,
      start_date,
      end_date,
      departure_hotel,
      end_hotel,
      driver_lang,
      duration,
      price_total,
      deposit_amount,
      name,
      phone,
      email,
      remark,
    } = req.body;

    // 生成订单号
    const order_id = generateOrderId();

    const { data, error } = await supabase.from('orders').insert([
      {
        order_id,
        car_model_id,
        start_date,
        end_date,
        departure_hotel,
        end_hotel,
        driver_lang,
        duration,
        price_total,
        deposit_amount,
        name,
        phone,
        email,
        remark,
        status: 'pending', // 默认未付款
      },
    ]);

    if (error) {
      console.error('❌ create-order 出错：', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ orderId: order_id });
  } catch (err) {
    console.error('❌ 未知错误：', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
