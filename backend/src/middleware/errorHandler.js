// Express 5 sends errors thrown in async routes here, so routes don't need their own try/catch.
module.exports = function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Request body is not valid JSON' });
  if (err.status && err.status < 500) return res.status(err.status).json({ message: err.message });
  if (err.name === 'CastError') return res.status(400).json({ message: `Invalid ${err.path}` });
  if (err.name === 'ValidationError') return res.status(400).json({ message: `Invalid ${Object.keys(err.errors || {}).join(', ') || 'input'}` });
  if (err.code === 11000) return res.status(409).json({ message: `${Object.keys(err.keyValue || {}).join(', ') || 'Value'} is already taken` });
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  return res.status(500).json({ message: 'Server error' });
};
