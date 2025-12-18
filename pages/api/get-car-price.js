import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  throw new Error("Missing Supabase env vars");
}

const supabase = createClient(supabaseUrl, serviceKey);

export default async function handler(req, res) {
  try {
    const {
      car_model_id,
      driver_lang,
      duration_hours,
      use_date,
    } = req.query;

    if (!car_model_id || !driver_lang || !duration_hours) {
      return res.status(400).json({
        error: "missing params",
        debug: { car_model_id, driver_lang, duration_hours },
      });
    }

    // 👉 价格规则查询（先日期，后兜底）
    const { data, error } = await supabase
      .from("car_prices")
      .select("*")
      .eq("car_model_id", car_model_id)
      .eq("driver_lang", driver_lang)
      .eq("duration_hours", Number(duration_hours))
      .or(
        use_date
          ? `and(start_date.lte.${use_date},end_date.gte.${use_date}),and(start_date.is.null,end_date.is.null)`
          : "and(start_date.is.null,end_date.is.null)"
      )
      .order("start_date", { ascending: false })
      .limit(1);

    if (error) {
      throw error;
    }

    const row = data?.[0] ?? null;

    return res.status(200).json({
      price: row ? Number(row.price_rmb) : 0,
      count: data?.length ?? 0,
      rows: data ?? [],
      debug: {
        car_model_id,
        driver_lang,
        duration_hours,
        use_date,
        picked: row?.id ?? null,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "server error",
      message: err.message,
    });
  }
}
