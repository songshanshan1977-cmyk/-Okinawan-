// /api/create-order.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const data = req.body;

    // 连接 Supabase（使用服务端 Key）
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 插入订单
    const { error } = await supabase
      .from("orders")
      .insert({
        order_id: data.order_id,
        car_model: data.car_model,
        car_model_id: data.car_model_id,
        driver_lang: data.driver_lang,
        duration: data.duration,

        start_date: data.start_date,
        end_date: data.end_date,
        departure_hotel: data.departure_hotel,
        end_hotel: data.end_hotel,

        name: data.name,
        phone: data.phone,
        email: data.email,
        remark: data.remark,

        pax: data.pax,
        luggage: data.luggage,

        deposit_amount: data.deposit_amount,
        total_price: data.total_price,
        source: data.source,
      });

    if (error) {
      console.error("插入订单失败：", error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("服务器错误：", err);
    return res.status(500).json({ error: "Server error" });
  }
}

