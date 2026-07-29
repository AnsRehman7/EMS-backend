const notificationService = require("../services/notification.service");
const asyncHandler = require("../utils/asyncHandler");
const { createPushSubscriptionSchema, parseBody } = require("../utils/validators");

const listNotifications = asyncHandler(async (req, res) => {
  const result = await notificationService.listNotifications(req.user);
  res.status(200).json({ data: result });
});

const markNotificationRead = asyncHandler(async (req, res) => {
  const notification = await notificationService.markNotificationRead(req.user, req.params.notificationId);
  res.status(200).json({ data: { notification } });
});

const markAllNotificationsRead = asyncHandler(async (req, res) => {
  await notificationService.markAllNotificationsRead(req.user);
  res.status(204).send();
});

const registerPushSubscription = asyncHandler(async (req, res) => {
  const payload = parseBody(createPushSubscriptionSchema, req.body);
  const subscription = await notificationService.registerPushSubscription(req.user, payload);
  res.status(201).json({ data: { subscription } });
});

const unregisterPushSubscription = asyncHandler(async (req, res) => {
  const token = String(req.body?.token || "").trim();
  if (!token) return res.status(400).json({ error: { message: "Push token is required." } });
  await notificationService.unregisterPushSubscription(req.user, token);
  return res.status(204).send();
});

module.exports = {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  registerPushSubscription,
  unregisterPushSubscription,
};
