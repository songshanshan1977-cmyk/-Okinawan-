import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  const { order_id } = req.query;

  if (!order_id) {
    return res.status(400).json({ error: "缺少 order_id" });
  }

  const { data, error } = await supabase
    .from("orders")
    .select(`
      *,
      car_models (
        name_zh
      )
    `)
    .eq("order_id", order_id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: "订单不存在" });
  }

  // ✅ 展示字段统一：car_name_zh
  const result = {
    ...data,
    car_name_zh: data.car_models?.name_zh || "",
  };

  delete result.car_models;

  res.status(200).json(result);
}
