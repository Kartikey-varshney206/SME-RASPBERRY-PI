const { spawn } = require('child_process');
const path = require('path');

console.log('=== SME Growth Advisor Unified Supervisor ===');

function startServer() {
    console.log('[Supervisor] Launching server.js...');
    const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        stdio: 'inherit',
        env: process.env
    });

    srv.on('exit', (code, sig) => {
        console.log(`[Supervisor] server.js exited (code: ${code}, signal: ${sig}). Auto-restarting in 2s...`);
        setTimeout(startServer, 2000);
    });

    srv.on('error', (err) => {
        console.error('[Supervisor] Failed to launch server.js:', err);
        setTimeout(startServer, 2000);
    });
}

function startTunnel() {
    console.log('[Supervisor] Launching tunnel.js...');
    const tun = spawn(process.execPath, [path.join(__dirname, 'tunnel.js')], {
        stdio: 'inherit',
        env: process.env
    });

    tun.on('exit', (code, sig) => {
        console.log(`[Supervisor] tunnel.js exited (code: ${code}, signal: ${sig}). Auto-restarting in 3s...`);
        setTimeout(startTunnel, 3000);
    });

    tun.on('error', (err) => {
        console.error('[Supervisor] Failed to launch tunnel.js:', err);
        setTimeout(startTunnel, 3000);
    });
}

// Start server first, then tunnel after server has initialized
startServer();
setTimeout(startTunnel, 2000);
