const fs = require('fs');
const https = require('https');
const { createApp } = require('./src/app');

const PORT = process.env.PORT || 3000;
const { app, server, io } = createApp();

// Browsers only allow camera/mic on https:// or http://localhost.
// For LAN/production, set SSL_KEY and SSL_CERT to serve over HTTPS (see README).
if (process.env.SSL_KEY && process.env.SSL_CERT) {
  const secure = https.createServer({ key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) }, app);
  io.attach(secure);
  secure.listen(PORT, () => console.log(`MeetUp running on https://localhost:${PORT}`));
} else {
  server.listen(PORT, () => console.log(`MeetUp running on http://localhost:${PORT}`));
}
