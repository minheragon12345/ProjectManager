import API from './api';

export const getNotes = async (search = '', scope = 'all', extra = {}) => {
  try {
    const params = {};
    if (search) params.search = search;
    if (scope && scope !== 'all') params.scope = scope; // mine | shared
    if (extra.projectId) params.projectId = extra.projectId;
    if (extra.status) params.status = extra.status;
    const response = await API.get('/notes', { params });
    return response.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not load tasks';
    throw new Error(message);
  }
};

export const createNote = async (noteData) => {
  try {
    const response = await API.post('/notes', noteData);
    return response.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Failed to create task';
    throw new Error(message);
  }
};

export const deleteNote = async (id) => {
  try {
    const response = await API.delete(`/notes/${id}`);
    return response.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Failed to delete task';
    throw new Error(message);
  }
};

export const updateNote = async (id, updatedData) => {
  try {
    const response = await API.put(`/notes/${id}`, updatedData);
    return response.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Failed to update task';
    throw new Error(message);
  }
};

export const getTrashNotes = async ({ projectId, search } = {}) => {
  try {
    const params = {};
    if (projectId) params.projectId = projectId;
    if (search) params.search = search;
    const response = await API.get('/notes/trash', { params });
    return response.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not load trash';
    throw new Error(message);
  }
};

export const restoreNote = async (id) => {
  try {
    const response = await API.patch(`/notes/${id}/restore`);
    return response.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Failed to restore task';
    throw new Error(message);
  }
};

export const deleteNotePermanent = async (id) => {
  try {
    const response = await API.delete(`/notes/${id}/hard`);
    return response.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Failed to delete permanently';
    throw new Error(message);
  }
};

// Subtasks
export const getSubtasks = async (parentId) => {
  try {
    const res = await API.get(`/notes/${parentId}/subtasks`);
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not load subtasks';
    throw new Error(message);
  }
};

export const createSubtask = async (parentId, fields) => {
  try {
    const res = await API.post('/notes', { ...fields, parentTask: parentId });
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not create subtask';
    throw new Error(message);
  }
};

// Dependencies
export const getBlockedBy = async (noteId) => {
  try {
    const res = await API.get(`/notes/${noteId}/dependencies/blocked-by`);
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not load dependencies';
    throw new Error(message);
  }
};

export const getBlocks = async (noteId) => {
  try {
    const res = await API.get(`/notes/${noteId}/dependencies/blocks`);
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not load dependent tasks';
    throw new Error(message);
  }
};

export const setDependencies = async (noteId, dependencies) => {
  try {
    const res = await API.put(`/notes/${noteId}/dependencies`, { dependencies });
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not set dependencies';
    throw new Error(message);
  }
};

export const addDependency = async (noteId, depId) => {
  try {
    const res = await API.post(`/notes/${noteId}/dependencies/${depId}`);
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not add dependency';
    throw new Error(message);
  }
};

export const removeDependency = async (noteId, depId) => {
  try {
    const res = await API.delete(`/notes/${noteId}/dependencies/${depId}`);
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not remove dependency';
    throw new Error(message);
  }
};

// Comment
export const getNoteComments = async (noteId) => {
  try {
    const res = await API.get(`/notes/${noteId}/comments`);
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not load comments';
    throw new Error(message);
  }
};

export const addNoteComment = async (noteId, text) => {
  try {
    const res = await API.post(`/notes/${noteId}/comments`, { text });
    return res.data;
  } catch (error) {
    const message = error.response?.data?.message || 'Could not post comment';
    throw new Error(message);
  }
};
