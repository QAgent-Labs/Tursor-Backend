#!/usr/bin/env node

const { spawn } = require('child_process');
const command = process.argv[2];
const fs = require('fs');
const path = require('path');

const PID_FILE = path.join(require('os').homedir(), '.tursor.pid');

switch (command) {
  case 'start': {
    try {
      const existingPid = fs.readFileSync(PID_FILE, 'utf-8');
      process.kill(existingPid, 0);
      console.log(`Tursor already running (PID: ${existingPid})`);
      break;
    } catch {
      // Not running → continue
    }
    console.log('Starting Tursor backend...');

    const build = spawn('npm', ['run', 'build'], { stdio: 'inherit' });
    build.on('close', (code) => {
      if (code !== 0) {
        console.log('Build failed. Aborting start.');
        return;
      }
      const child = spawn('npm', ['run', 'start:prod'], {
        detached: true,
        stdio: 'ignore',
      });

      child.unref();
      fs.writeFileSync(PID_FILE, String(child.pid));

      console.log(`Tursor started successfully (PID: ${child.pid})`);
    });

    break;
  }

  case 'stop': {
    try {
      const pid = fs.readFileSync(PID_FILE, 'utf-8');
      process.kill(pid);
      fs.unlinkSync(PID_FILE);
      console.log('Tursor stopped successfully');
    } catch (err) {
      console.log('Tursor is not running ' + err);
    }
    break;
  }

  case 'status': {
    const http = require('http');
    http
      .get('http://localhost:9090/health', (res) => {
        if (res.statusCode === 200) {
          console.log('Tursor is running');
        } else {
          console.log('Tursor is not healthy');
        }
      })
      .on('error', () => {
        console.log('Tursor is not running');
      });

    break;
  }

  case 'version':
    console.log('Tursor v0.0.1');
    break;

  case 'help':
  default:
    console.log(`
Tursor CLI

Commands:
  tursor start     Start backend
  tursor stop      Stop backend
  tursor status    Check backend status
  tursor version   Show version
    `);
}
