import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const order_id = `ORD-${Date.now()}`;

    const { data, error } = await supabase
      .from("orders")
      .insert([
        {
          order_id,
          name: "测试订单",
          phone: "0000000000",
          email: "test@test.com",
          start_date: "2025-12-13",
          status: "created",
          payment_status: "unpaid",
        },
      ])
      .select()
      .single();

    if (error) {
      console.error("❌ insert error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      success: true,
      order: data,
    });
  } catch (err) {
    console.error("❌ handler error:", err);
    return res.status(500).json({ error: "server error" });
  }
}


