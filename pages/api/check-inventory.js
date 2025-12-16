import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  try {
    const { date, car_model_id } = req.body;

    // ⭐ 参数校验
    if (!date || !car_model_id) {
      return res.json({ ok: false });
    }

    // ⭐ 强制把日期变成 YYYY-MM-DD（非常关键）
    const pureDate = date.slice(0, 10);

    const { data, error } = await supabase
      .from("库存")
      .select("id")
      .eq("date", pureDate)
      .eq("car_model_id", car_model_id)
      .gt("stock", 0)
      .limit(1);

    if (error) {
      console.error("check-inventory error:", error);
      return res.json({ ok: false });
    }

    return res.json({ ok: data && data.length > 0 });
  } catch (err) {
    console.error("check-inventory exception:", err);
    return res.json({ ok: false });
  }
}

