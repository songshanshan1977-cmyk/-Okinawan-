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

    // ---------- 1️⃣ 参数校验 ----------
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

    const dateToUse =
      use_date && String(use_date).length === 10
        ? use_date
        : null;

    // ---------- 2️⃣ 查询价格 ----------
    const { data, error } = await supabase
      .from("car_prices")
      .select("*")
      .eq("car_model_id", car_model_id)
      .eq("driver_lang", driver_lang)
      .eq("duration_hours", Number(duration_hours))
      .or(
        dateToUse
          ? `
            and(start_date.lte.${dateToUse},end_date.gte.${dateToUse}),
            and(start_date.is.null,end_date.is.null)
          `
          : `
            and(start_date.is.null,end_date.is.null)
          `
      )
      .order("start_date", { ascending: false, nullsLast: true })
      .limit(1);

    if (error) {
      return res.status(500).json({
        error: error.message,
      });
    }

    const picked = data?.[0] ?? null;

    return res.status(200).json({
      price: picked ? Number(picked.price_rmb) : 0,
      count: data?.length ?? 0,
      rows: data ?? [],
      debug: {
        car_model_id,
        driver_lang,
        duration_hours: Number(duration_hours),
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

