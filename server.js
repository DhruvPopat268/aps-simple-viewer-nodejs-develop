const express = require('express');
const { PORT } = require('./config.js');

let app = express();

// Configure server timeouts for large file downloads
app.use(express.static('wwwroot'));

// Increase request timeout and payload size limits
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Set custom timeout middleware
app.use((req, res, next) => {
    // Set request timeout to 15 minutes for file operations
    req.setTimeout(900000); // 15 minutes
    res.setTimeout(900000); // 15 minutes
    next();
});

app.use(require('./routes/auth.js'));
app.use(require('./routes/models.js'));

const server = app.listen(PORT, function () { 
    console.log(`Server listening on port ${PORT}...`); 
});

// Set server timeout to 20 minutes
server.timeout = 1200000; // 20 minutes
server.keepAliveTimeout = 1200000; // 20 minutes
server.headersTimeout = 1220000; // Slightly longer than keepAliveTimeout
