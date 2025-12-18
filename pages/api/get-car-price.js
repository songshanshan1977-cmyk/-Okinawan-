import { createClient } from '@supabase/supabase-js';

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
        error: 'missing params',
        debug: { car_model_id, driver_lang, duration_hours, use_date },
      });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const supabase = createClient(supabaseUrl, serviceKey);

    /**
     * 核心规则：
     * 1️⃣ 车型 / 司机 / 时长 必须匹配
     * 2️⃣ 日期命中其一即可：
     *    - 在 start_date ~ end_date 范围内
     *    - 或 start_date / end_date 都为 NULL（长期价）
     */
    const { data, error } = await supabase
      .from('car_prices')
      .select('*')
      .eq('car_model_id', car_model_id)
      .eq('driver_lang', driver_lang)
      .eq('duration_hours', Number(duration_hours))
      .or(
        use_date
          ? `and(start_date.lte.${use_date},end_date.gte.${use_date}),and(start_date.is.null,end_date.is.null)`
          : `and(start_date.is.null,end_date.is.null)`
      )
      .order('start_date', { ascending: false }) // 有日期的优先
      .order('created_at', { ascending: false }) // 新规则优先
      .limit(1);

    if (error) {
      return res.status(500).json({
        error: error.message,
        debug: { car_model_id, driver_lang, duration_hours, use_date },
      });
    }

    if (!data || data.length === 0) {
      return res.json({
        price: 0,
        picked: null,
        debug: { car_model_id, driver_lang, duration_hours, use_date },
      });
    }

    return res.json({
      price: data[0].price_rmb,
      picked: data[0],
      debug: { car_model_id, driver_lang, duration_hours, use_date },
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message,
      stack: e.stack,
    });
  }
}


