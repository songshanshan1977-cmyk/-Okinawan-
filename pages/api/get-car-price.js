const { data, error, count } = await supabase
  .from("car_prices")
  .select("*", { count: "exact" })
  .eq("car_model_id", car_model_id)
  .eq("driver_lang", driver_lang)
  .eq("duration_hours", duration_hours);

return res.json({
  price: data?.[0]?.price_rmb ?? 0,
  count,
  rows: data,
  error,
});

