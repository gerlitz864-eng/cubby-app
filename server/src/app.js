import express from 'express';
import cors from 'cors';
import { makeCtx, authMiddleware, errorMiddleware, h } from './lib/ctx.js';
import { createNotifier } from './lib/notify.js';
import { createFaceProvider } from './lib/face.js';
import authRoutes, { meRoute } from './routes/auth.js';
import attendanceRoutes from './routes/attendance.js';
import kioskRoutes from './routes/kiosk.js';
import notificationRoutes from './routes/notifications.js';
import alertRoutes from './routes/alerts.js';
import timeclockRoutes from './routes/timeclock.js';
import enrollmentRoutes from './routes/enrollment.js';
import suppliesRoutes from './routes/supplies.js';
import ordersRoutes from './routes/orders.js';
import purchasingRoutes from './routes/purchasing.js';
import mealsRoutes from './routes/meals.js';
import parentRoutes from './routes/parent.js';
import complianceRoutes from './routes/compliance.js';
import adminRoutes from './routes/admin.js';

export function createApp(db, config) {
  const ctx = makeCtx(db, config);
  ctx.notifier = createNotifier(config);
  ctx.face = createFaceProvider(config);

  const app = express();
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: '6mb' }));

  const pub = express.Router();
  pub.get('/health', h(async () => ({ ok: true, db: db.kind, demo: !!config.seedDemo, faceProvider: ctx.face.name })));
  authRoutes(pub, ctx);
  kioskRoutes(pub, ctx);
  app.use('/api', pub);

  const api = express.Router();
  api.use(authMiddleware(ctx));
  meRoute(api, ctx);
  attendanceRoutes(api, ctx);
  notificationRoutes(api, ctx);
  alertRoutes(api, ctx);
  timeclockRoutes(api, ctx);
  enrollmentRoutes(api, ctx);
  suppliesRoutes(api, ctx);
  ordersRoutes(api, ctx);
  purchasingRoutes(api, ctx);
  mealsRoutes(api, ctx);
  parentRoutes(api, ctx);
  complianceRoutes(api, ctx);
  adminRoutes(api, ctx);
  app.use('/api', api);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorMiddleware);
  app.ctx = ctx;
  return app;
}
