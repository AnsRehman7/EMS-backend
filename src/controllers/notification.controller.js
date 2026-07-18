const notificationService = require("../services/notification.service");
const asyncHandler = require("../utils/asyncHandler");

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

module.exports = {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
};
