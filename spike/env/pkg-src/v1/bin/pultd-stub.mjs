#!/usr/bin/env node
process.stdout.write(JSON.stringify({ daemon: 'pultd-dummy', version: '0.0.1', status: 'started' }) + '\n');
process.exit(0);
