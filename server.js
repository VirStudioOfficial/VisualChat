const express = require('express');
const path = require('path');
const chatHandler = require('./api/chat.js');

const app = express();
const PORT = 3000;

// Parse request bodies with generous payload size limits
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Mount /api/chat route
app.all('/api/chat', (req, res) => {
    chatHandler(req, res);
});

// Mount /api/manifest.json route
app.get('/api/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'api', 'manifest.json'));
});

// Serve static files from root
app.use(express.static(path.join(__dirname)));

// Fallback for SPA routing to index.html
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
