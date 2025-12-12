// pages/api/create-order.js

import { createClient } from "@supabase/supabase-js";

// ===== Supabase service role（必须）=====
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, serviceRoleKey);

// ===== 生成订单号（唯一可信来源）=====
function generateOrderId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.floor(10000 + Math.random() * 90000);
  return `ORD-${date}-${rand}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body;

    console.log("📥 /api/create-order 收到 body:", body);

    let {
      order_id,
      car_model_id,
      driver_lang,
      duration,
      start_date,
      end_date,
      departure_hotel,
      end_hotel,
      pax,
      luggage,
      total_price,
      deposit_amount,
      name,
      phone,
      email,
      remark,
      source,
    } = body;

    // === order_id 只能在这里生成 ===
    if (!order_id) {
      order_id = generateOrderId();
    }

    if (!deposit_amount) deposit_amount = 500;
    if (!source) source = "booking-page";

    const orderData = {
      order_id,
      car_model_id,
      driver_lang,
      duration,
      start_date,
      end_date,
      departure_hotel,
      end_hotel,
      pax,
      luggage,
      total_price,
      deposit_amount,
      name,
      phone,
      email,
      remark,
      source,

      status: "pending",
      payment_status: "pending",
      inventory_status: "pending",
      email_status: "pending",
      balance_paid: false,
    };

    console.log("📝 准备写入 orders:", orderData);

    const { data, error } = await supabase
      .from("orders")
      .insert(orderData)
      .select()
      .single();

    if (error) {
      console.error("❌ 写入 orders 失败:", error);
      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }

    console.log("✅ 订单写入成功:", data.order_id);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    console.error("🔥 /api/create-order 异常:", err);
    return res.status(500).json({
      success: false,
      error: "Server error",
    });
  }
}


