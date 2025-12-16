import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ ok: false });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return res.status(200).json({ ok: false });
    }

    const supabase = createClient(supabaseUrl, serviceKey);

    const { date, car_model_id } = req.body || {};
    if (!date || !car_model_id) {
      return res.status(200).json({ ok: false });
    }

    const pureDate = String(date).slice(0, 10);

    const { data, error } = await supabase
      .from("库存") // 中文表名
      .select("stock")
      .eq("date", pureDate)
      .eq("car_model_id", car_model_id);

    if (error || !data || data.length === 0) {
      return res.status(200).json({ ok: false });
    }

    // ✅ 关键：把同一天同车型的库存全部加起来
    const totalStock = data.reduce(
      (sum, row) => sum + Number(row.stock || 0),
      0
    );

    return res.status(200).json({
      ok: totalStock > 0,
      total_stock: totalStock, // 调试用
    });
  } catch (e) {
    return res.status(200).json({ ok: false });
  }
}

