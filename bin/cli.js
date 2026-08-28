#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  VERSION,
  printBanner,
  printSuccess,
  printError,
  printWarn,
  printInfo,
  printHelp,
  shouldShowBanner,
} = require('./tursor-ui');
const {
  PID_FILE,
  defaultHintPort,
  writeRuntime,
  clearRuntime,
  resolveBackendPort,
  pollHealthUntilUp,
} = require('./tursor-runtime');

const BACKEND_ROOT = path.resolve(__dirname, '..');

function spawnEnv() {
  const env = { ...process.env };
  const browsersPath = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (browsersPath?.includes('cursor-sandbox-cache')) {
    delete env.PLAYWRIGHT_BROWSERS_PATH;
  }
  return env;
}

const command = process.argv[2];
const argv = process.argv.slice(2);

if (shouldShowBanner(argv)) {
  printBanner();
}

switch (command) {
  case 'start': {
    void (async () => {
      try {
        const existingPid = fs.readFileSync(PID_FILE, 'utf-8');
        process.kill(existingPid, 0);
        printWarn(`Tursor is already running (PID ${existingPid})`);
        const status = await resolveBackendPort(argv);
        if (status.running && status.port) {
          writeRuntime({ port: status.port, pid: Number(existingPid) });
        }
        process.exit(0);
        return;
      } catch {
        /* not running */
      }

      printInfo('Building backend…');

      const build = spawn('npm', ['run', 'build'], {
        stdio: 'inherit',
        cwd: BACKEND_ROOT,
        env: spawnEnv(),
      });
      build.on('close', (code) => {
        if (code !== 0) {
          printError('Build failed. Start aborted.');
          process.exit(1);
          return;
        }
        printInfo('Starting production server…');
        const child = spawn('npm', ['run', 'start:prod'], {
          detached: true,
          stdio: 'ignore',
          cwd: BACKEND_ROOT,
          env: spawnEnv(),
        });

        child.unref();
        fs.writeFileSync(PID_FILE, String(child.pid));

        const hintPort = defaultHintPort();
        void (async () => {
          printInfo(`Waiting for health on port ${hintPort}…`);
          const status = await pollHealthUntilUp(hintPort);
          if (status.running && status.port) {
            writeRuntime({ port: status.port, pid: child.pid });
            printSuccess(`Tursor backend running (PID ${child.pid})`);
            printInfo(`API origin http://127.0.0.1:${status.port}`);
            printInfo('WebSocket at path /ws · Health at /health');
            process.exit(0);
            return;
          }
          printWarn(
            `Process started (PID ${child.pid}) but /health did not respond in time.`,
          );
          printInfo('Run `tursor port` after a few seconds to resolve the port.');
          process.exit(0);
        })();
      });
    })();

    break;
  }

  case 'stop': {
    try {
      const pid = fs.readFileSync(PID_FILE, 'utf-8');
      process.kill(pid);
      fs.unlinkSync(PID_FILE);
      clearRuntime();
      printSuccess('Tursor backend stopped');
      process.exit(0);
    } catch {
      clearRuntime();
      printWarn('Tursor is not running (no PID file or process gone)');
      process.exit(1);
    }
    break;
  }

  case 'status': {
    const jsonMode = argv.includes('--json');

    void (async () => {
      const status = await resolveBackendPort(argv);

      if (jsonMode) {
        console.log(
          JSON.stringify({
            running: status.running,
            port: status.running ? status.port : null,
          }),
        );
        process.exit(status.running ? 0 : 1);
        return;
      }

      if (status.running && status.port) {
        printSuccess('Tursor backend is healthy');
        printInfo(`Listening on http://127.0.0.1:${status.port}`);
        process.exit(0);
        return;
      }

      printError('Tursor backend is not running');
      printInfo(`Tried http://127.0.0.1:${defaultHintPort()}/health`);
      process.exit(1);
    })();

    break;
  }

  case 'port': {
    const jsonMode = argv.includes('--json');

    void (async () => {
      const status = await resolveBackendPort(argv);

      if (jsonMode) {
        const port = status.running ? status.port : null;
        console.log(
          JSON.stringify({
            running: status.running,
            port,
            origin:
              status.running && port
                ? `http://127.0.0.1:${port}`
                : null,
          }),
        );
        process.exit(status.running ? 0 : 1);
        return;
      }

      if (status.running && status.port) {
        console.log(String(status.port));
        process.exit(0);
        return;
      }

      process.exit(1);
    })();

    break;
  }

  case 'version':
    printSuccess(`Tursor v${VERSION}`);
    process.exit(0);
    break;

  case 'help':
    printHelp();
    process.exit(0);
    break;

  default:
    if (command) {
      printError(`Unknown command: ${command}`);
      console.log('');
    }
    printHelp();
    process.exit(command ? 1 : 0);
}
