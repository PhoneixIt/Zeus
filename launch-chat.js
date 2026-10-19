const { spawn } = require('child_process');
const pw = require('path').join('C:\\Users\\Samer\\Projects\\AIOS\\packages\\mission-engine\\live\\run-aios-chat.ts');
const child = spawn('powershell', [
  '-NoProfile',
  '-WindowStyle', 'Hidden',
  '-ExecutionPolicy', 'Bypass',
  '-Command',
  `& "${pw}" 57725 562e768442e645a8879a3af3`
], {
  cwd: 'C:\\Users\\Samer\\Projects\\AIOS',
  env: { ...process.env, PATH: process.env.PATH },
  stdio: ['ignore', 'pipe', 'pipe']
});

child.stdout.on('data', (data) => {
  process.stdout.write(data.toString());
});

child.stderr.on('data', (data) => {
  process.stderr.write(data.toString());
});

child.on('close', (code) => {
  process.exit(code);
});