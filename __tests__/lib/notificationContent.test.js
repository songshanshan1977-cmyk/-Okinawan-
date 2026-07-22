const { buildNotificationContent } = require("../../lib/webhook/notificationContent");

const ORDER = {
  order_id: "ORD-20260722-11111",
  start_date: "2026-08-01",
  end_date: "2026-08-01",
  car_model_id: "453df662-d350-4ab9-b811-61ffcda40d4b",
  driver_lang: "ZH",
  duration: 8,
  email: "customer@example.com",
  name: "Zhang San",
  phone: "13800000000",
  wechat: "zhangsan_wx",
  total_price: 1600,
  deposit_amount: 500,
  balance_due: 1100,
};

describe("buildNotificationContent", () => {
  test("customer_booking_confirmed -> success template, customer's own email", () => {
    const r = buildNotificationContent({ notificationType: "customer_booking_confirmed", order: ORDER, opsEmailTo: "ops@x.com" });
    expect(r.to).toBe(ORDER.email);
    expect(r.mail.subject).toContain("预约确认");
  });

  test("ops_booking_confirmed -> success template, ops address", () => {
    const r = buildNotificationContent({ notificationType: "ops_booking_confirmed", order: ORDER, opsEmailTo: "ops@x.com" });
    expect(r.to).toBe("ops@x.com");
    expect(r.mail.subject).toContain("新订单");
  });

  test("customer_manual_review -> pending template, customer's own email", () => {
    const r = buildNotificationContent({ notificationType: "customer_manual_review", order: ORDER, opsEmailTo: "ops@x.com" });
    expect(r.to).toBe(ORDER.email);
    expect(r.mail.subject).toContain("等待确认");
  });

  test("ops_manual_review -> urgent template, ops address, includes reason", () => {
    const r = buildNotificationContent({
      notificationType: "ops_manual_review",
      order: ORDER,
      reason: "failed_no_stock",
      stripeSessionId: "cs_test_abcdefghijklmnop",
      opsEmailTo: "ops@x.com",
    });
    expect(r.to).toBe("ops@x.com");
    expect(r.mail.subject).toContain("需要立即处理");
    expect(r.mail.html).toContain("failed_no_stock");
  });

  test("16. locked vs manual-review notification types produce different subjects (distinct dedupe_key semantics)", () => {
    const locked = buildNotificationContent({ notificationType: "customer_booking_confirmed", order: ORDER, opsEmailTo: "ops@x.com" });
    const pending = buildNotificationContent({ notificationType: "customer_manual_review", order: ORDER, opsEmailTo: "ops@x.com" });
    expect(locked.mail.subject).not.toBe(pending.mail.subject);
  });

  test("customer audience with no email on file -> to is null (caller must treat as nothing-to-send)", () => {
    const r = buildNotificationContent({
      notificationType: "customer_booking_confirmed",
      order: { ...ORDER, email: null },
      opsEmailTo: "ops@x.com",
    });
    expect(r.to).toBeNull();
  });

  test("unknown notification_type -> null (defensive)", () => {
    const r = buildNotificationContent({ notificationType: "something_unexpected", order: ORDER, opsEmailTo: "ops@x.com" });
    expect(r).toBeNull();
  });

  test("Stripe Session ID in the ops urgent email body is masked, never full", () => {
    const fullId = "cs_test_abcdefghijklmnopqrstuvwxyz";
    const r = buildNotificationContent({
      notificationType: "ops_manual_review",
      order: ORDER,
      reason: "amount_mismatch",
      stripeSessionId: fullId,
      opsEmailTo: "ops@x.com",
    });
    expect(r.mail.html).not.toContain(fullId);
  });

  describe("17/18. ops_session_order_conflict (R2 §六)", () => {
    test("ops address, mentions both order ids, never promises a booking", () => {
      const r = buildNotificationContent({
        notificationType: "ops_session_order_conflict",
        order: ORDER,
        stripeSessionId: "cs_test_conflict_session_id_1234567890",
        opsEmailTo: "ops@x.com",
        attemptedOrderId: "ORD-ATTEMPTED",
        existingOrderId: "ORD-EXISTING",
      });
      expect(r.to).toBe("ops@x.com");
      expect(r.mail.html).toContain("ORD-ATTEMPTED");
      expect(r.mail.html).toContain("ORD-EXISTING");
      expect(r.mail.subject).not.toContain("预约确认");
    });

    test("Session ID never appears in full in the conflict email body", () => {
      const fullId = "cs_test_conflict_session_id_1234567890";
      const r = buildNotificationContent({
        notificationType: "ops_session_order_conflict",
        order: ORDER,
        stripeSessionId: fullId,
        opsEmailTo: "ops@x.com",
        attemptedOrderId: "ORD-ATTEMPTED",
        existingOrderId: "ORD-EXISTING",
      });
      expect(r.mail.html).not.toContain(fullId);
    });

    test("does not depend on `order` content at all (works even with a minimal order object)", () => {
      const r = buildNotificationContent({
        notificationType: "ops_session_order_conflict",
        order: { order_id: "ORD-ATTEMPTED" },
        stripeSessionId: "cs_test_x",
        opsEmailTo: "ops@x.com",
        attemptedOrderId: "ORD-ATTEMPTED",
        existingOrderId: "ORD-EXISTING",
      });
      expect(r.to).toBe("ops@x.com");
    });
  });
});
