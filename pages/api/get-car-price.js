import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    const {
      car_model_id,
      driver_lang,
      duration_hours,
      use_date,
    } = req.method === "GET" ? req.query : req.body;

    // ---------- 参数校验 ----------
    if (!car_model_id || !driver_lang || !duration_hours) {
      return res.status(400).json({
        error: "missing params",
        debug: {
          car_model_id,
          driver_lang,
          duration_hours,
          use_date,
        },
      });
    }

    const hours = Number(duration_hours);
    const dateToUse =
      use_date && String(use_date).length === 10 ? use_date : null;

    let picked = null;
    let rows = [];

    // ---------- ① 先查「带日期」的价格 ----------
    if (dateToUse) {
      const { data, error } = await supabase
        .from("car_prices")
        .select("*")
        .eq("car_model_id", car_model_id)
        .eq("driver_lang", driver_lang)
        .eq("duration_hours", hours)
        .lte("start_date", dateToUse)
        .gte("end_date", dateToUse)
        .order("start_date", { ascending: false })
        .limit(1);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (data && data.length > 0) {
        picked = data[0];
        rows = data;
      }
    }

    // ---------- ② 如果没找到，再查「无日期」兜底 ----------
    if (!picked) {
      const { data, error } = await supabase
        .from("car_prices")
        .select("*")
        .eq("car_model_id", car_model_id)
        .eq("driver_lang", driver_lang)
        .eq("duration_hours", hours)
        .is("start_date", null)
        .is("end_date", null)
        .limit(1);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      if (data && data.length > 0) {
        picked = data[0];
        rows = data;
      }
    }

    // ---------- 返回 ----------
    return res.status(200).json({
      price: picked ? Number(picked.price_rmb) : 0,
      count: rows.length,
      rows,
      debug: {
        car_model_id,
        driver_lang,
        duration_hours: hours,
        use_date: dateToUse,
        picked: picked
          ? {
              id: picked.id,
              start_date: picked.start_date,
              end_date: picked.end_date,
              price_rmb: picked.price_rmb,
            }
          : null,
      },
    });
  } catch (e) {
    return res.status(500).json({
      error: "server_error",
      message: e.message,
    });
  }
}

