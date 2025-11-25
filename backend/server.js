// server.js - PostgreSQL Compatible Version
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

// Load environment variables
dotenv.config();

// Import services
const BlockchainService = require('./services/BlockchainService');
const DatabaseService = require('./services/DatabaseService');

// Import routes
const authRoutes = require('./routes/auth');
const documentRoutes = require('./routes/documents');
const verificationRoutes = require('./routes/verification');
const registrarRoutes = require('./routes/registrars');
const studentRoutes = require('./routes/students');
const templatesRoutes = require('./routes/templates');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Create required directories
const requiredDirs = [
    'uploads/temp',
    'uploads/processed',
    'uploads/originals',
    'uploads/watermarked' // ✅ ADDED: For watermarked files
];

requiredDirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
    }
});

// Initialize services
let dbConnection = null;
let blockchainService = null;

async function initializeServices() {
    try {
        // Initialize database
        console.log('Connecting to PostgreSQL database...');
        dbConnection = await DatabaseService.initialize();
        app.locals.db = DatabaseService; // ✅ CHANGED: Store the service, not the pool
        
        console.log('✅ PostgreSQL database connected successfully');
        
        // Initialize blockchain
        console.log('Initializing blockchain service...');
        blockchainService = new BlockchainService();
        
        const contractAddress = process.env.CONTRACT_ADDRESS || await getDeployedContractAddress();
        
        if (!contractAddress) {
            console.warn('⚠️ No contract address found. Deploy the contract first using: npx hardhat run scripts/deploy.js --network localhost');
            console.log('Blockchain features will be disabled');
        } else {
            await blockchainService.initialize(
                process.env.BLOCKCHAIN_URL || 'http://127.0.0.1:8545',
                process.env.REGISTRAR_PRIVATE_KEY || null,
                contractAddress
            );
            app.locals.blockchain = blockchainService;
            console.log('✅ Blockchain service initialized successfully');
        }
        
    } catch (error) {
        console.error('❌ Failed to initialize services:', error);
        // Don't throw error - allow server to start without blockchain if needed
        if (error.message.includes('database')) {
            console.error('💥 CRITICAL: Database connection failed. Server cannot start without database.');
            process.exit(1);
        }
    }
}

// Helper function to get deployed contract address
async function getDeployedContractAddress() {
    try {
        const deploymentPath = path.join(__dirname, 'deployments', 'localhost.json');
        if (fs.existsSync(deploymentPath)) {
            const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
            return deployment.contractAddress;
        }
        
        // Also check for hardhat-deploy format
        const chainId = 31337; // Hardhat default
        const hardhatDeployPath = path.join(__dirname, 'deployments', 'hardhat', `${chainId}.json`);
        if (fs.existsSync(hardhatDeployPath)) {
            const deployment = JSON.parse(fs.readFileSync(hardhatDeployPath, 'utf8'));
            return deployment.address;
        }
        
        return null;
    } catch (error) {
        console.error('Error reading deployment info:', error);
        return null;
    }
}

// API Routes - Order matters! More specific routes first
app.use('/api/auth', authRoutes);
app.use('/api/verify', verificationRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/registrars', registrarRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/templates', templatesRoutes);

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        // ✅ ADDED: Test database connection
        let dbStatus = 'disconnected';
        let dbTables = [];
        
        if (dbConnection) {
            try {
                // Test database connection with a simple query
                const result = await DatabaseService.query('SELECT NOW() as current_time');
                dbStatus = 'connected';
                
                // Check if tables exist
                const tablesResult = await DatabaseService.query(`
                    SELECT table_name 
                    FROM information_schema.tables 
                    WHERE table_schema = 'public'
                `);
                dbTables = tablesResult.rows.map(row => row.table_name);
            } catch (dbError) {
                dbStatus = 'error: ' + dbError.message;
            }
        }
        
        res.json({
            status: 'ok',
            server: 'running',
            database: dbStatus,
            database_tables: dbTables,
            blockchain: blockchainService?.initialized ? 'connected' : 'disconnected',
            contractAddress: blockchainService?.contractAddress || 'not deployed',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

// Database status endpoint
app.get('/api/database/status', async (req, res) => {
    try {
        if (!dbConnection) {
            return res.status(500).json({
                connected: false,
                error: 'Database service not initialized'
            });
        }
        
        // Get database statistics
        const tablesResult = await DatabaseService.query(`
            SELECT 
                table_name,
                (SELECT count(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
            FROM information_schema.tables t
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);
        
        // Get row counts for main tables
        const documentCount = await DatabaseService.query('SELECT COUNT(*) as count FROM documents');
        const registrarCount = await DatabaseService.query('SELECT COUNT(*) as count FROM registrars');
        const studentCount = await DatabaseService.query('SELECT COUNT(*) as count FROM students');
        
        res.json({
            connected: true,
            database_type: 'PostgreSQL',
            tables: tablesResult.rows,
            statistics: {
                documents: parseInt(documentCount.rows[0].count),
                registrars: parseInt(registrarCount.rows[0].count),
                students: parseInt(studentCount.rows[0].count)
            },
            connection: {
                host: process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : 'local',
                ssl: process.env.NODE_ENV === 'production'
            }
        });
        
    } catch (error) {
        res.status(500).json({
            connected: false,
            error: 'Failed to get database status',
            message: error.message
        });
    }
});

// Blockchain status endpoint
app.get('/api/blockchain/status', async (req, res) => {
    try {
        if (!blockchainService?.initialized) {
            return res.json({
                connected: false,
                message: 'Blockchain service not initialized'
            });
        }
        
        const stats = await blockchainService.getContractStats();
        res.json({
            connected: true,
            contractAddress: blockchainService.contractAddress,
            network: process.env.BLOCKCHAIN_URL || 'http://127.0.0.1:8545',
            stats
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to get blockchain status',
            message: error.message
        });
    }
});

// System info endpoint
app.get('/api/system/info', (req, res) => {
    res.json({
        system: 'Document Verification System',
        version: '1.0.0',
        database: 'PostgreSQL',
        blockchain: 'Ethereum/Hardhat',
        features: [
            'Document upload and processing',
            'QR code generation',
            'Blockchain verification',
            'Digital watermarking',
            'PDF and image support',
            'Word document conversion'
        ],
        upload_limits: {
            max_file_size: '10MB',
            supported_formats: ['PDF', 'PNG', 'JPG', 'JPEG', 'DOCX']
        }
    });
});

// Static files - serve frontend (put this AFTER API routes)
app.use(express.static(path.join(__dirname, 'public')));

// Frontend routes - these serve the HTML files
app.get('/verify/:hash', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});

app.get('/verify', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});

// Admin route
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Student route
app.get('/student', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'student.html'));
});

// Catch-all for frontend routing (SPA)
app.get('/', (req, res) => {
    if (fs.existsSync(path.join(__dirname, 'public', 'index.html'))) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else if (fs.existsSync(path.join(__dirname, 'public', 'admin.html'))) {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    } else {
        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Document Verification System</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
                    h1 { color: #333; }
                    ul { list-style-type: none; padding: 0; }
                    li { margin: 10px 0; }
                    a { color: #007bff; text-decoration: none; }
                    a:hover { text-decoration: underline; }
                    .status { padding: 10px; border-radius: 5px; margin: 10px 0; }
                    .connected { background: #d4edda; color: #155724; }
                    .disconnected { background: #f8d7da; color: #721c24; }
                </style>
            </head>
            <body>
                <h1>📄 Document Verification System</h1>
                <p>Server is running on port ${PORT}</p>
                
                <div class="status ${dbConnection ? 'connected' : 'disconnected'}">
                    💾 Database: ${dbConnection ? '✅ Connected' : '❌ Disconnected'}
                </div>
                
                <div class="status ${blockchainService?.initialized ? 'connected' : 'disconnected'}">
                    ⛓️ Blockchain: ${blockchainService?.initialized ? '✅ Connected' : '❌ Disconnected'}
                </div>
                
                <h2>Quick Links:</h2>
                <ul>
                    <li>👨‍💼 <a href="/admin">Admin Portal</a></li>
                    <li>👨‍🎓 <a href="/student">Student Portal</a></li>
                    <li>🔍 <a href="/verify">Verification Portal</a></li>
                    <li>🏥 <a href="/api/health">Health Check</a></li>
                    <li>💾 <a href="/api/database/status">Database Status</a></li>
                    <li>⛓️ <a href="/api/blockchain/status">Blockchain Status</a></li>
                    <li>📊 <a href="/api/system/info">System Info</a></li>
                </ul>
            </body>
            </html>
        `);
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Server Error:', error);
    
    // Send JSON response for API routes
    if (req.path.startsWith('/api/')) {
        res.status(500).json({
            error: 'Internal server error',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
            ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
        });
    } else {
        // Send HTML response for frontend routes
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Error 500</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 40px; text-align: center; }
                    h1 { color: #dc3545; }
                </style>
            </head>
            <body>
                <h1>Error 500 - Internal Server Error</h1>
                <p>Something went wrong on our server.</p>
                <a href="/">Go back to home</a>
            </body>
            </html>
        `);
    }
});

// 404 handler - must be last
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        res.status(404).json({ 
            error: 'Not found',
            path: req.path,
            method: req.method,
            available_endpoints: [
                '/api/health',
                '/api/database/status', 
                '/api/blockchain/status',
                '/api/system/info',
                '/api/auth/*',
                '/api/documents/*',
                '/api/verify/*',
                '/api/registrars/*',
                '/api/students/*',
                '/api/templates/*'
            ]
        });
    } else {
        // Try to serve index.html for frontend routes (SPA)
        const indexPath = path.join(__dirname, 'public', 'index.html');
        if (fs.existsSync(indexPath)) {
            res.sendFile(indexPath);
        } else {
            res.status(404).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>404 - Not Found</title>
                    <style>
                        body { font-family: Arial, sans-serif; margin: 40px; text-align: center; }
                        h1 { color: #6c757d; }
                    </style>
                </head>
                <body>
                    <h1>404 - Page Not Found</h1>
                    <p>The page <code>${req.path}</code> was not found</p>
                    <a href="/">Go back to home</a>
                </body>
                </html>
            `);
        }
    }
});

// Start server
async function startServer() {
    try {
        await initializeServices();
        
        app.listen(PORT, () => {
            console.log('='.repeat(80));
            console.log(`🚀 Document Verification System`);
            console.log(`📡 Server: http://localhost:${PORT}`);
            console.log(`💾 Database: ${dbConnection ? '✅ PostgreSQL Connected' : '❌ Disconnected'}`);
            console.log(`⛓️  Blockchain: ${blockchainService?.initialized ? '✅ Connected' : '❌ Disconnected'}`);
            if (blockchainService?.contractAddress) {
                console.log(`📄 Contract: ${blockchainService.contractAddress}`);
            }
            console.log('');
            console.log('📍 Available endpoints:');
            console.log(`   🏥 Health Check:     http://localhost:${PORT}/api/health`);
            console.log(`   💾 Database Status:  http://localhost:${PORT}/api/database/status`);
            console.log(`   🔗 Blockchain Status: http://localhost:${PORT}/api/blockchain/status`);
            console.log(`   📊 System Info:      http://localhost:${PORT}/api/system/info`);
            console.log(`   👨‍💼 Admin Portal:      http://localhost:${PORT}/admin`);
            console.log(`   👨‍🎓 Student Portal:    http://localhost:${PORT}/student`);
            console.log(`   🔍 Verification:      http://localhost:${PORT}/verify`);
            console.log('='.repeat(80));
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    try {
        // Close PostgreSQL connection pool
        await DatabaseService.close();
        console.log('✅ Database connections closed');
    } catch (error) {
        console.error('❌ Error closing database connections:', error);
    }
    
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    
    try {
        await DatabaseService.close();
        console.log('✅ Database connections closed');
    } catch (error) {
        console.error('❌ Error closing database connections:', error);
    }
    
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

startServer();

module.exports = app;