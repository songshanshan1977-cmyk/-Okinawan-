// pages/api/create-order.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY 
);

// 固定押金 500 RMB
const DEPOSIT_AMOUNT = 500;
const STRIPE_DEPOSIT_PRICE_ID = process.env.STRIPE_DEPOSIT_PRICE_ID;

// 订单号生成：ORD-20250101-随机6位数
function generateOrderId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `ORD-${date}-${rand}`;
}

// 当日不能下单（按日本时间）
function isSameDayJapan(dateStr) {
  const nowJST = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })
  );
  const target = new Date(`${dateStr}T00:00:00+09:00`);

  return (
    target.getFullYear() === nowJST.getFullYear() &&
    target.getMonth() === nowJST.getMonth() &&
    target.getDate() === nowJST.getDate()
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method Not Allowed' });

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

    // 必填验证
    if (!car_model_id || !start_date || !name || !phone) {
      return res.status(400).json({
        errorCode: 'MISSING_FIELDS',
        message: '缺少字段（车型、日期、姓名、电话）'
      });
    }

    // 校验：当日不能下单
    if (isSameDayJapan(start_date)) {
      return res.status(400).json({
        errorCode: 'SAME_DAY',
        message: '不能在用车当天下单，请至少提前一天预订。'
      });
    }

    const order_id = generateOrderId();

    // 写入 Supabase
    const { error } = await supabase.from('orders').insert([
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
        status: 'pending'
      }
    ]);

    if (error) {
      console.error("❌ create-order 错误：", error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      orderId: order_id,
      priceTotal: price_total,
      depositAmount: DEPOSIT_AMOUNT,
      priceId: STRIPE_DEPOSIT_PRICE_ID
    });

  } catch (err) {
    console.error("❌ 未知错误：", err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
