'use strict';

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForService(child, { timeoutMs = 60000, logPath, maxLineBytes = 65536 } = {}) {
  return new Promise((resolve, reject) => {
    let pending = '', tail = '', oversized = false, settled = false;
    const details = () => `${tail ? `\n${tail.trim()}` : ''}${logPath ? `\nLog: ${logPath}` : ''}`;
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.stdout.removeListener('data', onData);
      child.stderr.removeListener('data', onStderr);
      error ? reject(error) : resolve(port);
    };
    const onError = error => finish(new Error(`Cannot start the local service: ${error.message}.${details()}`));
    const onExit = (code, signal) => finish(new Error(`Local service exited before it was ready (${signal || code}).${details()}`));
    const onStderr = bytes => { tail = (tail + bytes.toString()).slice(-2000); };
    const onData = bytes => {
      const parts = bytes.toString().split('\n');
      for (let index = 0; index < parts.length; index++) {
        pending += parts[index];
        if (pending.length > maxLineBytes) { pending = ''; oversized = true; }
        if (index === parts.length - 1) continue;
        if (!oversized) {
          try {
            const record = JSON.parse(pending);
            if (record.event === 'ready' && Number.isInteger(record.port) && record.port > 0 && record.port <= 65535) {
              finish(undefined, record.port);
              return;
            }
          } catch {}
        }
        pending = ''; oversized = false;
      }
    };
    const timer = setTimeout(() => finish(new Error(`Local service did not become ready within ${timeoutMs / 1000} seconds.${details()}`)), timeoutMs);
    child.once('error', onError);
    child.once('exit', onExit);
    child.stdout.on('data', onData);
    child.stderr.on('data', onStderr);
    if (hasExited(child)) onExit(child.exitCode, child.signalCode);
  });
}

function stopService(child, { graceMs = 6000, forceTimeoutMs = 2000, forceStop } = {}) {
  if (!child || hasExited(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false, forcing = false, forceTimer;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(forceTimer);
      child.removeListener('exit', onExit);
      child.stdin?.removeListener('error', onStdinError);
      error ? reject(error) : resolve();
    };
    const onExit = () => finish();
    const force = async () => {
      if (settled || forcing) return;
      forcing = true;
      forceTimer = setTimeout(() => finish(new Error('Owned service did not exit after forced shutdown.')), forceTimeoutMs);
      try {
        await forceStop(child);
        if (hasExited(child)) finish();
      } catch (error) { finish(error); }
    };
    const onStdinError = () => { clearTimeout(timer); void force(); };
    const timer = setTimeout(() => { void force(); }, graceMs);
    child.once('exit', onExit);
    child.stdin?.once('error', onStdinError);
    try {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end('shutdown\n');
      else onStdinError();
    } catch { onStdinError(); }
  });
}

module.exports = { waitForService, stopService, hasExited };
