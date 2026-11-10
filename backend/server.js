const dotenv = require('dotenv');

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';
const required = isProduction ? ['MONGO_URI', 'JWT_SECRET', 'CORS_ORIGIN'] : ['MONGO_URI', 'JWT_SECRET'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}. See backend/.env.example.`);
  process.exit(1);
}

// Loaded after dotenv so the app sees CORS_ORIGIN and TRUST_PROXY.
const connectDB = require('./src/config/db');
const app = require('./src/app');

const PORT = process.env.PORT || 5000;
connectDB()
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch((err) => {
    console.error('Could not connect to MongoDB:', err.message);
    process.exit(1);
  });
