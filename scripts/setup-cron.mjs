import { loadConfig } from '../src/config.js';

try {
  const config = await loadConfig();
  // Root opens Docker's log descriptors before run-requester drops privileges.
  process.stdout.write(`SHELL=/bin/sh\nPATH=/usr/local/bin:/usr/bin:/bin\nMAILTO=""\n${config.scheduleCron.trim()} root /usr/local/bin/run-requester >>/proc/1/fd/1 2>>/proc/1/fd/2\n`);
} catch (error) {
  console.error(`[INIT] ${error.message}`);
  process.exitCode = 1;
}
