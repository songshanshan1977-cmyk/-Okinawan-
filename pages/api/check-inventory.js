import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  const { date, car_model_id } = req.body;

  if (!date || !car_model_id) {
    return res.status(400).json({ ok: false });
  }

  const { data, error } = await supabase
    .from("库存")          // ⚠️ 表名：你现在叫「库存」
    .select("id")
    .eq("date", date)
    .eq("car_model_id", car_model_id)
    .gt("stock", 0)
    .limit(1);

  if (error) {
    console.error("check inventory error:", error);
    return res.status(500).json({ ok: false });
  }

  return res.json({
    ok: data && data.length > 0,
  });
}
