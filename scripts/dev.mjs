import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDetailFlowServer } from '../server/app.mjs';
import { demoAuthOptions, messengersFromEnv } from '../server/messenger/from-env.mjs';

mkdirSync(resolve('data'), { recursive: true });
const api = createDetailFlowServer({
  databasePath: resolve('data/detailflow-dev.db'), seed: true, messengers: messengersFromEnv(), ...demoAuthOptions()
});
api.listen(4174, '127.0.0.1', () => console.log('API: http://127.0.0.1:4174'));

const vite = spawn('pnpm', ['exec', 'vite'], { stdio: 'inherit', shell: true });
const stop = () => {
  vite.kill();
  api.close(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
vite.on('exit', (code) => api.close(() => process.exit(code ?? 0)));
