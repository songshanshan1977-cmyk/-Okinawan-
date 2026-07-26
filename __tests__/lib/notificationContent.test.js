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

    test("17. R3 §五 (N-03 fix): wording no longer claims neither order was confirmed — order A's original state is explicitly said to be UNCHANGED, only order B is said to be unpaid/unlocked", () => {
      const r = buildNotificationContent({
        notificationType: "ops_session_order_conflict",
        order: ORDER,
        stripeSessionId: "cs_test_wording_check_1234567890",
        opsEmailTo: "ops@x.com",
        attemptedOrderId: "ORD-B-ATTEMPTED",
        existingOrderId: "ORD-A-EXISTING",
      });
      // the old, incorrect claim must be gone
      expect(r.mail.html).not.toContain("系统未对任何一个订单做出");
      // the corrected claims must be present: no order was modified by this
      // conflict attempt; order A's state is explicitly preserved/unaffected;
      // order B (the attempted one) is explicitly unpaid/unlocked.
      expect(r.mail.html).toContain("没有修改任何订单");
      expect(r.mail.html).toMatch(/未被这次冲突影响|未被.*撤销/);
      expect(r.mail.html).toContain("未被标记为已付款");
      expect(r.mail.html).toContain("未锁定库存");
    });
  });

  describe("R3 §三: ops_missing_customer_email", () => {
    test("8/9. ops address; body explicitly states payment/processing status, missing email, no customer notification, stopped auto-retry, need for manual contact, order id, payment_status, inventory_status, and a masked Session ID", () => {
      const orderWithStatus = {
        ...ORDER,
        email: null,
        payment_status: "paid",
        inventory_status: "failed",
      };
      const fullSessionId = "cs_test_missing_email_1234567890abcdef";
      const r = buildNotificationContent({
        notificationType: "ops_missing_customer_email",
        order: orderWithStatus,
        stripeSessionId: fullSessionId,
        opsEmailTo: "ops@x.com",
      });

      expect(r.to).toBe("ops@x.com");
      expect(r.mail.subject).not.toContain("预约确认");
      expect(r.mail.subject).not.toContain("新订单");
      expect(r.mail.html).toContain(orderWithStatus.order_id);
      expect(r.mail.html).toContain("付款"); // "已经付款或正在进行付款处理"
      expect(r.mail.html).toContain("没有客户邮箱地址");
      expect(r.mail.html).toContain("完全没有收到系统的任何通知");
      expect(r.mail.html).toContain("自动邮件重试已经停止");
      expect(r.mail.html).toMatch(/电话|微信|人工联系/);
      expect(r.mail.html).toContain("paid"); // payment_status
      expect(r.mail.html).toContain("failed"); // inventory_status
      expect(r.mail.html).not.toContain(fullSessionId);
    });

    test("never reads as a routine booking-confirmed notice", () => {
      const r = buildNotificationContent({
        notificationType: "ops_missing_customer_email",
        order: { ...ORDER, email: null, payment_status: "paid", inventory_status: "pending" },
        stripeSessionId: "cs_test_x",
        opsEmailTo: "ops@x.com",
      });
      expect(r.mail.html).not.toContain("预约已确认");
    });
  });
});
