const express = require('express');
const cors = require('cors');
const app = express();
// doService masih diimpor karena mungkin digunakan di tempat lain atau untuk testing langsung
const doService = require('./services/doService');

app.use(express.json());
app.use(cors({
    origin: ['http://albacore-direct-neatly.ngrok-free.app',
        
        'https://jauharimalik.github.io', 
        'https://cute-mature-shrew.ngrok-free.app',
        'https://cute-mature-shrew.ngrok-free.app','http://192.168.60.19',
        'https://jauharimalik.github.io/sapapi'],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

// Database middleware
app.use(async (req, res, next) => {
    // Pastikan app.get('pool') mengembalikan objek pool database yang benar
    req.pool = app.get('pool');
    next();
});

// Routes
// Semua rute API akan dihandle oleh apiRoutes
const apiRoutes = require('./routes/apiRoutes');
app.use('/api', apiRoutes); // Semua rute di apiRoutes akan diawali dengan /api

// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Terjadi kesalahan pada server!' });
});

module.exports = app;
