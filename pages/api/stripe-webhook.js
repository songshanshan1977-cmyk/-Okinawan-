if (
  event.type === "checkout.session.completed" ||
  event.type === "payment_intent.succeeded"
) {
  let orderId;

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    orderId = session.metadata?.orderId;
  }

  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object;
    orderId = intent.metadata?.orderId;
  }

  if (!orderId) {
    console.warn("⚠️ Webhook success but no orderId");
    return res.json({ received: true });
  }

  console.log("✅ Webhook confirmed payment for:", orderId);

  // 1️⃣ 更新订单
  await supabase
    .from("orders")
    .update({
      payment_status: "paid",
      paid_at: new Date().toISOString(),
    })
    .eq("order_id", orderId);

  // 2️⃣ 写入 payments
  await supabase.from("payments").insert({
    order_id: orderId,
    stripe_session_id: event.data.object.id,
    amount: event.data.object.amount_total || event.data.object.amount,
    currency: event.data.object.currency,
    status: "paid",
  });
}

