const projectService = require("../services/project.service");
const asyncHandler = require("../utils/asyncHandler");
const { createProjectSchema, parseBody, updateProjectSchema } = require("../utils/validators");

const listProjects = asyncHandler(async (req, res) => {
  const projects = await projectService.listProjects(req.user);
  res.status(200).json({ data: { projects } });
});

const getProjectById = asyncHandler(async (req, res) => {
  const project = await projectService.getProjectById(req.params.projectId, req.user);
  res.status(200).json({ data: { project } });
});

const createProject = asyncHandler(async (req, res) => {
  const payload = parseBody(createProjectSchema, req.body);
  const project = await projectService.createProject(req.user, payload);
  res.status(201).json({ data: { project } });
});

const updateProject = asyncHandler(async (req, res) => {
  const payload = parseBody(updateProjectSchema, req.body);
  const project = await projectService.updateProject(req.params.projectId, req.user, payload);
  res.status(200).json({ data: { project } });
});

const deleteProject = asyncHandler(async (req, res) => {
  const result = await projectService.deleteProject(req.params.projectId, req.user);

  if (result.deleted) {
    return res.status(204).send();
  }

  return res.status(200).json({ data: result });
});

module.exports = {
  createProject,
  deleteProject,
  getProjectById,
  listProjects,
  updateProject,
};
