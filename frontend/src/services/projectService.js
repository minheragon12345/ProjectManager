import API from './api';

export const getProjects = async ({ search = '', scope = 'all', status = '' } = {}) => {
  try {
    const params = {};
    if (search) params.search = search;
    if (scope && scope !== 'all') params.scope = scope; // mine | shared
    if (status) params.status = status; // active | archived
    const res = await API.get('/projects', { params });
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not load projects';
    throw new Error(message);
  }
};

export const getProject = async (id) => {
  try {
    const res = await API.get(`/projects/${id}`);
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not load project';
    throw new Error(message);
  }
};

export const createProject = async (data) => {
  try {
    const res = await API.post('/projects', data);
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Failed to create project';
    throw new Error(message);
  }
};

export const updateProject = async (id, data) => {
  try {
    const res = await API.put(`/projects/${id}`, data);
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Failed to update project';
    throw new Error(message);
  }
};

export const archiveProject = async (id) => {
  try {
    const res = await API.patch(`/projects/${id}/archive`);
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Failed to archive project';
    throw new Error(message);
  }
};

export const deleteProject = async (id) => {
  try {
    const res = await API.delete(`/projects/${id}`);
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Failed to delete project';
    throw new Error(message);
  }
};

export const getProjectMembers = async (id) => {
  try {
    const res = await API.get(`/projects/${id}/members`);
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not load members';
    throw new Error(message);
  }
};

export const addProjectMember = async (id, { email, role }) => {
  try {
    const res = await API.post(`/projects/${id}/members`, { email, role });
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not add member';
    throw new Error(message);
  }
};

export const updateProjectMemberRole = async (id, memberUserId, role) => {
  try {
    const res = await API.patch(`/projects/${id}/members/${memberUserId}`, { role });
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not update role';
    throw new Error(message);
  }
};

export const getBudgetSummary = async (id) => {
  try {
    const res = await API.get(`/projects/${id}/budget-summary`);
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not load budget summary';
    throw new Error(message);
  }
};

export const removeProjectMember = async (id, memberUserId) => {
  try {
    const res = await API.delete(`/projects/${id}/members/${memberUserId}`);
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not remove member';
    throw new Error(message);
  }
};

export const getProjectAuditLog = async (id, { limit = 200 } = {}) => {
  try {
    const res = await API.get(`/projects/${id}/audit-log`, { params: { limit } });
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not load audit log';
    throw new Error(message);
  }
};

export const getProjectSchedule = async (id, { constrained = false } = {}) => {
  try {
    const params = constrained ? { constrained: 'true' } : undefined;
    const res = await API.get(`/projects/${id}/schedule`, { params });
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not load schedule';
    throw new Error(message);
  }
};

export const getResourceCurve = async (id, { constrained = false } = {}) => {
  try {
    const params = constrained ? { constrained: 'true' } : undefined;
    const res = await API.get(`/projects/${id}/resource-curve`, { params });
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not load resource curve';
    throw new Error(message);
  }
};

export const getCrashAnalysis = async (id) => {
  try {
    const res = await API.get(`/projects/${id}/crash-analysis`);
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not load crashing analysis';
    throw new Error(message);
  }
};
