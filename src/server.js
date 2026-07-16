import { createRuntime } from './app.js';

const runtime = await createRuntime();
const address = await runtime.listen();
const visibleHost = address.address === '::' ? 'localhost' : address.address;
console.log(`KMXT server listening at http://${visibleHost}:${address.port}`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down.`);
  await runtime.close();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
