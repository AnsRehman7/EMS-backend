const taskService = require("../services/task.service");
const asyncHandler = require("../utils/asyncHandler");
const {
  createTaskSchema,
  createTaskAttachmentSchema,
  createTaskCommentSchema,
  createTimeLogSchema,
  parseBody,
  updateTaskSchema,
  updateTaskStatusSchema,
  setTaskWatchingSchema,
} = require("../utils/validators");

const listTasks = asyncHandler(async (req, res) => {
  const result = await taskService.listTasks(req.user, req.query);
  res.status(200).json({ data: result });
});

const listTaskComments = asyncHandler(async (req, res) => {
  const comments = await taskService.listTaskComments(req.params.taskId, req.user);
  res.status(200).json({ data: { comments } });
});

const createTaskComment = asyncHandler(async (req, res) => {
  const payload = parseBody(createTaskCommentSchema, req.body);
  const comment = await taskService.createTaskComment(req.params.taskId, req.user, payload);
  res.status(201).json({ data: { comment } });
});

const setTaskWatching = asyncHandler(async (req, res) => {
  const payload = parseBody(setTaskWatchingSchema, req.body);
  const result = await taskService.setTaskWatching(req.params.taskId, req.user, payload.watching);
  res.status(200).json({ data: result });
});

const listTaskAttachments = asyncHandler(async (req, res) => {
  const attachments = await taskService.listTaskAttachments(req.params.taskId, req.user);
  res.status(200).json({ data: { attachments } });
});

const createTaskAttachment = asyncHandler(async (req, res) => {
  const payload = parseBody(createTaskAttachmentSchema, req.body);
  const attachment = await taskService.createTaskAttachment(req.params.taskId, req.user, payload);
  res.status(201).json({ data: { attachment } });
});

const getTaskStats = asyncHandler(async (req, res) => {
  const stats = await taskService.getTaskStats(req.user);
  res.status(200).json({ data: { stats } });
});

const getTaskById = asyncHandler(async (req, res) => {
  const task = await taskService.getTaskById(req.params.taskId, req.user);
  res.status(200).json({ data: { task } });
});

const getTaskActivity = asyncHandler(async (req, res) => {
  const activity = await taskService.getTaskActivity(req.params.taskId, req.user);
  res.status(200).json({ data: { activity } });
});

const createTask = asyncHandler(async (req, res) => {
  const payload = parseBody(createTaskSchema, req.body);
  const task = await taskService.createTask(req.user, payload);

  res.status(201).json({ data: { task } });
});

const updateTaskStatus = asyncHandler(async (req, res) => {
  const payload = parseBody(updateTaskStatusSchema, req.body);
  const task = await taskService.updateTaskStatus(req.params.taskId, payload, req.user);

  res.status(200).json({ data: { task } });
});

const updateTask = asyncHandler(async (req, res) => {
  const payload = parseBody(updateTaskSchema, req.body);
  const task = await taskService.updateTask(req.params.taskId, req.user, payload);

  res.status(200).json({ data: { task } });
});

const createTimeLog = asyncHandler(async (req, res) => {
  const payload = parseBody(createTimeLogSchema, req.body);
  const timeLog = await taskService.createTimeLog(req.params.taskId, req.user, payload);

  res.status(201).json({ data: { timeLog } });
});

const deleteTask = asyncHandler(async (req, res) => {
  await taskService.deleteTask(req.params.taskId, req.user);
  res.status(204).send();
});

module.exports = {
  createTaskAttachment,
  createTaskComment,
  createTimeLog,
  createTask,
  deleteTask,
  getTaskActivity,
  getTaskById,
  getTaskStats,
  listTaskAttachments,
  listTaskComments,
  listTasks,
  setTaskWatching,
  updateTask,
  updateTaskStatus,
};
