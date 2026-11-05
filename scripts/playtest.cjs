/* Local-only, disposable-data playtest. Never opens a tunnel or changes deployment. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../backend/server');

if (process.argv.length > 3 || (process.argv[2] && !/^\d+$/.test(process.argv[2]))) {
  console.error('Usage: node scripts/playtest.cjs [port]');
  process.exit(1);
}
const port = Number(process.argv[2] ?? 3100);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('Port must be an integer between 0 and 65535.');
  process.exit(1);
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airplane-playtest-'));
let app;
function clean() {
  app?.locals.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
try {
  app = createApp({ dataDir, allowedOrigins: [] });
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`Local playtest: http://127.0.0.1:${server.address().port}`);
    console.log('Only this computer can connect. This is not a phone-accessible or public URL.');
    console.log('Uses an empty temporary leaderboard; existing data is never imported.');
    console.log('Ctrl+C stops the server and removes this temporary leaderboard. Browser best scores remain local.');
  });
  server.once('error', error => {
    console.error(`Cannot start playtest: ${error.code || error.name}`);
    clean();
    process.exitCode = 1;
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(clean);
    server.closeAllConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  console.error(`Cannot start playtest: ${error.code || error.name}`);
  clean();
  process.exitCode = 1;
}
