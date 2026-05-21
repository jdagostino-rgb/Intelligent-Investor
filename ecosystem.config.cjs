// PM2 ecosystem config
// Start with: pm2 start ecosystem.config.cjs
// Save process list: pm2 save
// Auto-start on reboot: pm2 startup

module.exports = {
  apps: [
    {
      name:         'ii-backend',
      script:       'server/server.js',
      instances:    1,
      autorestart:  true,
      watch:        false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        PORT:     3001,
        // Keys are set as DigitalOcean environment variables, not here
      },
      error_file:  'logs/error.log',
      out_file:    'logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
