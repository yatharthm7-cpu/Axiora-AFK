module.exports = {
    apps: [{
        name: 'axiora-afk',
        script: 'index.js',
        cwd: __dirname,
        exec_mode: 'fork',
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '1G',
        env: {
            NODE_ENV: 'production'
        }
    }]
};
