import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { date: rawDate, car_model_id } = req.body;

    if (!rawDate || !car_model_id) {
      return res.status(400).json({ ok: false });
    }

    // ✅ 关键修复：统一日期格式
    const date = rawDate.slice(0, 10);

    const { data, error } = await supabase
      .from("库存")
      .select("stock")
      .eq("date", date)
      .eq("car_model_id", car_model_id)
      .single();

    if (error || !data) {
      return res.status(200).json({ ok: false });
    }

    return res.status(200).json({
      ok: data.stock > 0,
    });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
}
