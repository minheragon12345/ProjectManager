import API from './api';

export const getUsers = async (search = '') => {
  try {
    const params = search ? { search } : undefined;
    const response = await API.get('/admin/users', { params });
    return response.data;
  } catch (error) {
    throw new Error(error.response?.data?.message || 'Could not load users');
  }
};

export const updateBillingRate = async (id, { billingRate, billingCurrency }) => {
  try {
    const response = await API.patch(`/admin/users/${id}/billing-rate`, { billingRate, billingCurrency });
    return response.data;
  } catch (error) {
    throw new Error(error.response?.data?.message || 'Could not update the billing rate');
  }
};
