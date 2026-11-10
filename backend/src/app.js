const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const authController = require('./controller/authController');
const noteController = require('./controller/noteController');
const taskLinkController = require('./controller/taskLinkController');
const adminController = require('./controller/adminController');
const projectController = require('./controller/projectController');
const timeEntryController = require('./controller/timeEntryController');
const errorHandler = require('./middleware/errorHandler');

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : ['http://localhost:5173', 'http://localhost:4173'];

const app = express();
// Behind a proxy (Render, Railway, nginx) the rate limiter needs the real client IP.
app.set('trust proxy', Number(process.env.TRUST_PROXY) || false);
app.use(helmet());
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.use('/api/auth', authController);
app.use('/api/notes', noteController);
app.use('/api/notes', taskLinkController);
app.use('/api/projects', projectController);
app.use('/api/time-entries', timeEntryController);
app.use('/api/admin', adminController);
app.use('/api', (req, res) => res.status(404).json({ message: 'Not found' }));
app.use(errorHandler);

module.exports = app;
