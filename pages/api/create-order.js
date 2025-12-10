// pages/api/create-order.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // 只在服务端用
);

// 固定押金 500 RMB
const DEPOSIT_AMOUNT = 500;
const STRIPE_DEPOSIT_PRICE_ID = process.env.STRIPE_DEPOSIT_PRICE_ID;

// 订单号生成：ORD-20251209-随机6位数
function generateOrderId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `ORD-${date}-${rand}`;
}

// 当日不能下单（按日本时间）
function isSameDayInJapan(dateStr) {
  if (!dateStr) return false;
  const target = new Date(`${dateStr}T00:00:00+09:00`);
  const now = new Date();

  const japanNow = new Date(
    now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })
  );

  return (
    target.getFullYear() === japanNow.getFullYear() &&
    target.getMonth() === japanNow.getMonth() &&
    target.getDate() === japanNow.getDate()
  );
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
      name,
      phone,
      email,
      remark,
    } = req.body;

    // 1）校验必填
    if (!car_model_id || !start_date || !name || !phone) {
      return res.status(400).json({
        errorCode: 'MISSING_FIELDS',
        message: '缺少必要字段（车型 / 日期 / 姓名 / 电话）',
      });
    }

    // 2）当日不能下单
    if (isSameDayInJapan(start_date)) {
      return res.status(400).json({
        errorCode: 'SAME_DAY_NOT_ALLOWED',
        message: '不能在用车当天下单，请至少提前 1 天预订。',
      });
    }

    // 3）生成订单号
    const order_id = generateOrderId();

    // 4）写入 Supabase orders 表
    const { data, error } = await supabase
      .from('orders')
      .insert([
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
          deposit_amount: DEPOSIT_AMOUNT,
          name,
          phone,
          email,
          remark,
          status: 'pending', // 未支付
        },
      ])
      .select()
      .single();

    if (error) {
      console.error('❌ create-order 出错：', error);
      return res.status(500).json({ error: error.message });
    }

    // 5）返回给前端：订单号 + 押金金额 + Stripe PriceId
    return res.status(200).json({
      orderId: order_id,
      depositAmount: DEPOSIT_AMOUNT,
      priceTotal: data.price_total,
      priceId: STRIPE_DEPOSIT_PRICE_ID,
    });
  } catch (err) {
    console.error('❌ 未知错误：', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
