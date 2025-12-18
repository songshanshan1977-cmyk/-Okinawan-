import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  try {
    const {
      car_model_id,
      driver_lang,
      duration_hours,
      use_date,
    } = req.query;

    // ---------- 参数校验 ----------
    if (!car_model_id || !driver_lang || !duration_hours) {
      return res.status(400).json({
        error: 'missing params',
        debug: { car_model_id, driver_lang, duration_hours, use_date },
      });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({
        error: 'env missing',
        debug: {
          hasUrl: !!supabaseUrl,
          hasServiceKey: !!serviceKey,
        },
      });
    }

    const supabase = createClient(supabaseUrl, serviceKey);

    // ---------- 基础条件 ----------
    let query = supabase
      .from('car_prices')
      .select('*')
      .eq('car_model_id', car_model_id)
      .eq('driver_lang', driver_lang)
      .eq('duration_hours', Number(duration_hours));

    // ---------- 日期逻辑 ----------
    if (use_date) {
      query = query
        .lte('start_date', use_date)
        .gte('end_date', use_date);
    } else {
      // 没传日期：只用“长期价”（start_date / end_date 都是 null）
      query = query
        .is('start_date', null)
        .is('end_date', null);
    }

    // ---------- 执行 ----------
    const { data, error } = await query.order('created_at', { ascending: false });

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

    // ---------- 命中价格 ----------
    const picked = data[0];

    return res.json({
      price: picked.price_rmb,
      picked,
      debug: {
        car_model_id,
        driver_lang,
        duration_hours,
        use_date,
      },
    });

  } catch (e) {
    return res.status(500).json({
      error: e.message,
      stack: e.stack,
    });
  }
}


