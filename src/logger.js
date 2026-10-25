const levels = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(level = 'info', secrets = []) {
  return Object.fromEntries(Object.keys(levels).map((name) => [name, (message) => {
    if (levels[name] < levels[level]) return;
    let safe = String(message);
    for (const secret of secrets.filter((value) => typeof value === 'string' && value.length > 0).sort((a, b) => b.length - a.length)) {
      safe = safe.replaceAll(secret, '[REDACTED]');
    }
    const line = JSON.stringify({ time: new Date().toISOString(), level: name, message: safe });
    (name === 'error' ? console.error : console.log)(line);
  }]));
}
