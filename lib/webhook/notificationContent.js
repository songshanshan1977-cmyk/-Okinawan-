// lib/webhook/notificationContent.js
//
// Maps a claimed send_logs outbox row's notification_type to the actual
// email content + recipient. Kept separate from the claim/send/complete
// orchestration in pages/api/stripe-webhook.js so that mapping is a single,
// testable, side-effect-free function.

const {
  buildCustomerSuccessEmail,
  buildOpsSuccessEmail,
  buildCustomerPendingEmail,
  buildOpsUrgentEmail,
  buildOpsSessionOrderConflictEmail,
} = require("./emailTemplates");

const NOTIFICATION_TYPES = [
  "customer_booking_confirmed",
  "ops_booking_confirmed",
  "customer_manual_review",
  "ops_manual_review",
  "ops_session_order_conflict",
];

/**
 * @param {object} params
 * @param {string} params.notificationType
 * @param {object} params.order
 * @param {string|null} [params.reason]
 * @param {string} [params.stripeSessionId]
 * @param {string} params.opsEmailTo
 * @param {string} [params.attemptedOrderId] - only used by ops_session_order_conflict
 * @param {string} [params.existingOrderId] - only used by ops_session_order_conflict
 * @returns {{mail: {subject:string, html:string}, to: string|null} | null}
 *   null when notificationType is not one this webhook knows how to build
 *   content for (defensive — should never happen for rows this webhook
 *   itself inserted).
 */
function buildNotificationContent({
  notificationType,
  order,
  reason,
  stripeSessionId,
  opsEmailTo,
  attemptedOrderId,
  existingOrderId,
}) {
  switch (notificationType) {
    case "customer_booking_confirmed":
      return { mail: buildCustomerSuccessEmail(order), to: order.email || null };
    case "ops_booking_confirmed":
      return { mail: buildOpsSuccessEmail(order), to: opsEmailTo };
    case "customer_manual_review":
      return { mail: buildCustomerPendingEmail(order), to: order.email || null };
    case "ops_manual_review":
      return { mail: buildOpsUrgentEmail(order, reason, stripeSessionId), to: opsEmailTo };
    case "ops_session_order_conflict":
      return {
        mail: buildOpsSessionOrderConflictEmail({ attemptedOrderId, existingOrderId, stripeSessionId }),
        to: opsEmailTo,
      };
    default:
      return null;
  }
}

module.exports = { buildNotificationContent, NOTIFICATION_TYPES };
