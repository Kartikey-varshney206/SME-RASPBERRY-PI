const { spawn } = require('child_process');

function runTunnel() {
    console.log('[Tunnel] Starting SSH tunnel to localhost.run...');
    const proc = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'BatchMode=yes',
        '-R', '80:localhost:3000',
        'nokey@localhost.run'
    ], { stdio: 'pipe' });

    proc.stdout.on('data', (d) => {
        const text = d.toString();
        process.stdout.write(text);
    });

    proc.stderr.on('data', (d) => {
        process.stderr.write(d.toString());
    });

    proc.on('close', (code) => {
        console.log(`[Tunnel] Process exited with code ${code}. Reconnecting in 3 seconds...`);
        setTimeout(runTunnel, 3000);
    });

    proc.on('error', (err) => {
        console.error('[Tunnel] Error:', err.message);
        setTimeout(runTunnel, 3000);
    });
}

runTunnel();
