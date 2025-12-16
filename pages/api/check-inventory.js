import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ ok: false });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      console.error("❌ missing env");
      return res.status(200).json({ ok: false });
    }

    const supabase = createClient(supabaseUrl, serviceKey);

    const { date, car_model_id } = req.body || {};

    if (!date || !car_model_id) {
      return res.status(200).json({ ok: false });
    }

    const pureDate = String(date).slice(0, 10);

    const { data, error } = await supabase
      .from("库存") // ⚠️ 必须是中文
      .select("stock")
      .eq("date", pureDate)
      .eq("car_model_id", car_model_id)
      .limit(1);

    if (error) {
      console.error("❌ supabase error", error);
      return res.status(200).json({ ok: false });
    }

    if (!data || data.length === 0) {
      return res.status(200).json({ ok: false });
    }

    return res.status(200).json({
      ok: Number(data[0].stock) > 0,
    });
  } catch (e) {
    console.error("❌ fatal error", e);
    return res.status(200).json({ ok: false });
  }
}

