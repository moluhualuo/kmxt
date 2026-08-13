import { createRuntime } from './app.js';

const runtime = await createRuntime();
const address = await runtime.listen();
const visibleHost = address.address === '::' ? 'localhost' : address.address;
console.log(`KMXT server listening at http://${visibleHost}:${address.port}`);

let shutdownPromise = null;
async function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  console.log(`Received ${signal}; shutting down.`);
  shutdownPromise = runtime.close()
    .then(() => { process.exitCode = 0; })
    .catch((error) => {
      console.error('Graceful shutdown failed:', error);
      process.exitCode = 1;
    });
  return shutdownPromise;
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
