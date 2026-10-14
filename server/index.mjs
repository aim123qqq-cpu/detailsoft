import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDetailFlowServer } from './app.mjs';

mkdirSync(resolve('data'), { recursive: true });
const port = Number(process.env.PORT ?? 4173);
const server = createDetailFlowServer({
  databasePath: process.env.DATABASE_PATH ?? resolve('data/detailflow.db'),
  seed: process.env.SEED_DEMO !== 'false',
  staticDir: resolve('dist'),
  features: { qualityControl: process.env.ENABLE_QC === 'true' }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`DetailFlow is running at http://127.0.0.1:${port}`);
});
