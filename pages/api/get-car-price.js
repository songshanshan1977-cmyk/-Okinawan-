// pages/api/get-car-price.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function pickFirstDefined(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export default async function handler(req, res) {
  try {
    // ✅ 同时支持 GET(querystring) & POST(json)
    const src = req.method === "GET" ? (req.query || {}) : (req.body || {});

    const car_model_id = pickFirstDefined(src, ["car_model_id", "carModelId"]);
    const driver_lang = pickFirstDefined(src, ["driver_lang", "driverLang"]);
    const durationRaw = pickFirstDefined(src, ["duration_hours", "duration_hour", "duration"]);
    const use_date = pickFirstDefined(src, ["use_date", "date", "start_date"]);

    const duration_hours = toInt(durationRaw);

    // 参数校验
    if (!car_model_id || !driver_lang || !Number.isFinite(duration_hours)) {
      return res.status(400).json({
        error: "missing params",
        debug: { car_model_id, driver_lang, duration_hours },
      });
    }

    // 统一语言值（保险）
    const lang = String(driver_lang).toUpperCase(); // "ZH" / "JP"
    const useDate = use_date ? String(use_date) : null; // "YYYY-MM-DD" or null

    // -----------------------------
    // ✅ 查询策略（非常关键）
    // 1) 如果传了 use_date：优先找【start_date <= use_date <= end_date】的价格行
    // 2) 找不到，再回退到【start_date is null AND end_date is null】的基础价
    //
    // ✅ 同时兼容两种字段命名：duration_hours / duration_hour
    // -----------------------------

    async function queryWithDurationColumn(durationColumnName, mode) {
      // mode: "dated" | "base"
      let q = supabase
        .from("car_prices")
        .select("id,car_model_id,start_date,end_date,created_at,driver_lang,duration_hours,duration_hour,price_rmb")
        .eq("car_model_id", car_model_id)
        .eq("driver_lang", lang)
        .eq(durationColumnName, duration_hours);

      if (mode === "dated") {
        q = q.not("start_date", "is", null).not("end_date", "is", null)
             .lte("start_date", useDate)
             .gte("end_date", useDate);
      } else {
        q = q.is("start_date", null).is("end_date", null);
      }

      // 取最新的一条（防止重复行）
      const { data, error } = await q.order("created_at", { ascending: false }).limit(1);

      if (error) return { rows: [], error };
      return { rows: data || [], error: null };
    }

    async function queryPrice(mode) {
      // 先试 duration_hours
      let r = await queryWithDurationColumn("duration_hours", mode);
      if (r.rows.length > 0) return r;

      // 再试 duration_hour（兼容你 UI/历史字段名）
      r = await queryWithDurationColumn("duration_hour", mode);
      return r;
    }

    let result = { rows: [], error: null };

    // ① 有日期：先找 dated
    if (useDate) {
      result = await queryPrice("dated");
    }

    // ② 没找到：回退 base
    if (!result.rows || result.rows.length === 0) {
      result = await queryPrice("base");
    }

    const row = (result.rows && result.rows[0]) ? result.rows[0] : null;
    const price = row ? Number(row.price_rmb || 0) : 0;

    return res.status(200).json({
      price,
      count: result.rows ? result.rows.length : 0,
      rows: result.rows || [],
      debug: {
        car_model_id,
        driver_lang: lang,
        duration_hours,
        use_date: useDate,
        picked: row ? row.id : null,
      },
    });
  } catch (e) {
    return res.status(500).json({
      error: "server error",
      message: String(e?.message || e),
    });
  }
}

