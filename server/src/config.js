import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT || 4000),
  // Leave DATABASE_URL empty to use the embedded PostgreSQL (great for trying it out).
  // Set it to a real PostgreSQL 15+ connection string in production.
  databaseUrl: env.DATABASE_URL || '',
  dataDir: env.DATA_DIR || path.resolve('./data/pgdata'),
  jwtSecret: env.JWT_SECRET || 'dev-only-change-me',
  // Secret used to key-hash PINs before they reach the database. Keep it OUTSIDE the database.
  pinPepper: env.PIN_PEPPER || 'dev-only-pepper-change-me',
  uploadDir: env.UPLOAD_DIR || path.resolve('./data/uploads'),
  // Providers: 'console' logs messages instead of sending them. 'twilio' sends real texts and calls.
  notifyProvider: env.NOTIFY_PROVIDER || 'console',
  twilio: { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM },
  // 'mock' accepts any face (DEMO ONLY, identifies nobody). Plug a real provider into lib/face.js.
  faceProvider: env.FACE_PROVIDER || 'mock',
  production: env.NODE_ENV === 'production',
  seedDemo: env.SEED_DEMO !== 'false',
  runJobs: env.RUN_JOBS !== 'false',
  jobIntervalMs: Number(env.JOB_INTERVAL_MS || 60000),
  webOrigin: env.WEB_ORIGIN || 'http://localhost:5173'
};
