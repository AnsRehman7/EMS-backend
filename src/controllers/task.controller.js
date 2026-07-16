const taskService = require("../services/task.service");
const asyncHandler = require("../utils/asyncHandler");
const {
  createTaskSchema,
  createTimeLogSchema,
  parseBody,
  updateTaskSchema,
  updateTaskStatusSchema,
} = require("../utils/validators");

const listTasks = asyncHandler(async (req, res) => {
  const tasks = await taskService.listTasks(req.user);
  res.status(200).json({ data: { tasks } });
});

const getTaskStats = asyncHandler(async (req, res) => {
  const stats = await taskService.getTaskStats(req.user);
  res.status(200).json({ data: { stats } });
});

const getTaskById = asyncHandler(async (req, res) => {
  const task = await taskService.getTaskById(req.params.taskId, req.user);
  res.status(200).json({ data: { task } });
});

const createTask = asyncHandler(async (req, res) => {
  const payload = parseBody(createTaskSchema, req.body);
  const task = await taskService.createTask(req.user, payload);

  res.status(201).json({ data: { task } });
});

const updateTaskStatus = asyncHandler(async (req, res) => {
  const payload = parseBody(updateTaskStatusSchema, req.body);
  const task = await taskService.updateTaskStatus(req.params.taskId, payload.status, req.user);

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
  createTimeLog,
  createTask,
  deleteTask,
  getTaskById,
  getTaskStats,
  listTasks,
  updateTask,
  updateTaskStatus,
};
