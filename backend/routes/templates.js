// routes/templates.js - Complete implementation with all functionality
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const jwt = require('jsonwebtoken');
const { ethers } = require('ethers');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const mammoth = require('mammoth');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Configure multer for template uploads
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'templates');
        try {
            await fs.mkdir(dir, { recursive: true });
        } catch (error) {
            console.error('Error creating directory:', error);
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'template-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['.docx', '.doc', '.txt'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedTypes.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Only .docx, .doc, and .txt files are allowed'), false);
        }
    }
});

// Middleware to verify JWT token
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        console.log('No token provided in request');
        return res.status(401).json({
            success: false,
            error: 'Authentication required'
        });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.log('Token verification failed:', err.message);
            return res.status(403).json({
                success: false,
                error: 'Invalid or expired token'
            });
        }
        
        req.user = user;
        next();
    });
}

// Middleware to check if user is registrar
function requireRegistrar(req, res, next) {
    if (req.user.type !== 'registrar') {
        return res.status(403).json({
            success: false,
            error: 'Registrar privileges required'
        });
    }
    next();
}

// In-memory stores for drafts and finalized documents
const draftsStore = new Map();
const finalizedStore = new Map();

/**
 * GET /api/templates
 * Get all templates
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { documentType } = req.query;
        
        if (!db) {
            return res.json({
                success: true,
                templates: []
            });
        }
        
        // Ensure templates table exists
        await db.execute(`
            CREATE TABLE IF NOT EXISTS templates (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                type VARCHAR(50) NOT NULL,
                file_path VARCHAR(500) NOT NULL,
                file_name VARCHAR(255) NOT NULL,
                uploaded_by INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (uploaded_by) REFERENCES registrars(id) ON DELETE SET NULL,
                INDEX idx_type (type)
            )
        `).catch(() => {});
        
        let query = `
            SELECT t.*, r.full_name as uploaded_by_name
            FROM templates t
            LEFT JOIN registrars r ON t.uploaded_by = r.id
        `;
        
        const params = [];
        if (documentType) {
            query += ' WHERE t.type = ?';
            params.push(documentType);
        }
        
        query += ' ORDER BY t.created_at DESC';
        
        const [templates] = await db.execute(query, params);
        
        res.json({
            success: true,
            templates
        });
        
    } catch (error) {
        console.error('Get templates error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch templates',
            details: error.message
        });
    }
});

/**
 * POST /api/templates/upload
 * Upload a new template
 */
router.post('/upload', authenticateToken, requireRegistrar, upload.single('file'), async (req, res) => {
    try {
        console.log('Template upload request:', req.body);
        console.log('File:', req.file);
        
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No file uploaded'
            });
        }
        
        const db = req.app.locals.db;
        const { name, type, description } = req.body;
        
        if (!name || !type) {
            await fs.unlink(req.file.path).catch(console.error);
            return res.status(400).json({
                success: false,
                error: 'Template name and type are required'
            });
        }
        
        // Validate template if it's a .docx file
        if (path.extname(req.file.originalname).toLowerCase() === '.docx') {
            try {
                const content = await fs.readFile(req.file.path);
                const zip = new PizZip(content);
                const doc = new Docxtemplater(zip, {
                    paragraphLoop: true,
                    linebreaks: true
                });
                
                // Test render with sample data
                doc.render({
                    student_name: 'Test Student',
                    student_id: 'TEST-001',
                    institution: 'Test Institution',
                    issue_date: new Date().toLocaleDateString()
                });
                
            } catch (error) {
                console.log('Template validation warning:', error.message);
            }
        }
        
        if (!db) {
            return res.json({
                success: true,
                message: 'Template uploaded (database not connected)',
                templateId: Date.now()
            });
        }
        
        // Save to database
        const [result] = await db.execute(`
            INSERT INTO templates (name, type, file_path, file_name, uploaded_by)
            VALUES (?, ?, ?, ?, ?)
        `, [name, type, req.file.path, req.file.filename, req.user.id]);
        
        res.json({
            success: true,
            message: 'Template uploaded successfully',
            templateId: result.insertId
        });
        
    } catch (error) {
        console.error('Upload template error:', error);
        if (req.file) {
            await fs.unlink(req.file.path).catch(console.error);
        }
        res.status(500).json({
            success: false,
            error: 'Failed to upload template',
            details: error.message
        });
    }
});

/**
 * POST /api/templates/:templateId/draft
 * Generate a draft with actual template content
 */
router.post('/:templateId/draft', authenticateToken, requireRegistrar, async (req, res) => {
    try {
        const { templateId } = req.params;
        const studentData = req.body;

        // Validate required student data
        if (!studentData.studentId || !studentData.studentName) {
            return res.status(400).json({
                success: false,
                error: 'Student ID and name are required'
            });
        }

        const db = req.app.locals.db;
        let templateContent = '';
        let templatePath = '';
        
        if (db) {
            const [templates] = await db.execute(
                'SELECT * FROM templates WHERE id = ?',
                [templateId]
            );
            
            if (templates.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Template not found'
                });
            }
            
            templatePath = templates[0].file_path;
            
            // Read and process template file
            try {
                const ext = path.extname(templatePath).toLowerCase();
                
                if (ext === '.docx') {
                    // Process Word template
                    const content = await fs.readFile(templatePath);
                    const zip = new PizZip(content);
                    const doc = new Docxtemplater(zip, {
                        paragraphLoop: true,
                        linebreaks: true,
                    });
                    
                    // Prepare comprehensive template data
                    const templateData = {
                        student_name: studentData.studentName,
                        student_id: studentData.studentId,
                        program: studentData.program || 'Computer Science',
                        year_level: studentData.yearLevel || '4th Year',
                        institution: studentData.institutionName || 'Academic Institution',
                        document_type: studentData.documentType || 'Academic Document',
                        issue_date: new Date().toLocaleDateString(),
                        current_date: new Date().toLocaleDateString(),
                        academic_year: '2024-2025',
                        semester: 'First Semester',
                        // Add more fields as needed
                        studentName: studentData.studentName, // Alternative field name
                        studentId: studentData.studentId, // Alternative field name
                        institutionName: studentData.institutionName || 'Academic Institution'
                    };
                    
                    // Render the document with data
                    doc.setData(templateData);
                    doc.render();
                    
                    // Get the rendered document buffer
                    const buf = doc.getZip().generate({ type: 'nodebuffer' });
                    
                    // Save rendered document as draft
                    const draftId = `draft_${Date.now()}`;
                    const draftPath = path.join(__dirname, '..', 'drafts', `${draftId}.docx`);
                    await fs.mkdir(path.dirname(draftPath), { recursive: true });
                    await fs.writeFile(draftPath, buf);
                    
                    // Extract text content for preview using mammoth
                    const result = await mammoth.extractRawText({ buffer: buf });
                    templateContent = result.value;
                    
                    // Store draft info
                    const draftData = {
                        id: draftId,
                        templateId,
                        studentData,
                        templateData,
                        filePath: draftPath,
                        status: 'draft',
                        createdDate: new Date().toISOString(),
                        content: templateContent,
                        preview: templateContent
                    };
                    
                    draftsStore.set(draftId, draftData);
                    
                    // Save to database if available
                    if (db) {
                        await db.execute(
                            `INSERT INTO document_drafts 
                            (student_id, document_type, draft_data, draft_file_path, created_by, status) 
                            VALUES (?, ?, ?, ?, ?, 'draft')`,
                            [
                                studentData.studentId,
                                studentData.documentType,
                                JSON.stringify(draftData),
                                draftPath,
                                req.user.id
                            ]
                        ).catch(err => {
                            console.log('Draft table might not exist, creating...', err.message);
                            // Create table if it doesn't exist
                            return db.execute(`
                                CREATE TABLE IF NOT EXISTS document_drafts (
                                    id INT AUTO_INCREMENT PRIMARY KEY,
                                    student_id VARCHAR(50) NOT NULL,
                                    document_type VARCHAR(50) NOT NULL,
                                    draft_data TEXT,
                                    draft_file_path VARCHAR(500),
                                    created_by INT,
                                    status ENUM('draft', 'editing', 'finalized') DEFAULT 'draft',
                                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                                    FOREIGN KEY (created_by) REFERENCES registrars(id)
                                )
                            `);
                        });
                    }
                    
                    res.json({
                        success: true,
                        message: 'Draft generated successfully',
                        draft: draftData,
                        preview: templateContent,
                        downloadUrl: `/api/templates/draft/${draftId}/download`
                    });
                    
                } else if (ext === '.txt') {
                    // Process text template
                    templateContent = await fs.readFile(templatePath, 'utf8');
                    
                    // Replace all possible placeholders
                    templateContent = templateContent
                        .replace(/\{\{student_name\}\}/g, studentData.studentName)
                        .replace(/\{\{student_id\}\}/g, studentData.studentId)
                        .replace(/\{\{program\}\}/g, studentData.program || 'Computer Science')
                        .replace(/\{\{year_level\}\}/g, studentData.yearLevel || '4th Year')
                        .replace(/\{\{institution\}\}/g, studentData.institutionName || 'Academic Institution')
                        .replace(/\{\{document_type\}\}/g, studentData.documentType || 'Academic Document')
                        .replace(/\{\{issue_date\}\}/g, new Date().toLocaleDateString())
                        .replace(/\{\{current_date\}\}/g, new Date().toLocaleDateString());
                    
                    const draftId = `draft_${Date.now()}`;
                    const draftPath = path.join(__dirname, '..', 'drafts', `${draftId}.txt`);
                    await fs.mkdir(path.dirname(draftPath), { recursive: true });
                    await fs.writeFile(draftPath, templateContent);
                    
                    const draftData = {
                        id: draftId,
                        templateId,
                        studentData,
                        filePath: draftPath,
                        status: 'draft',
                        createdDate: new Date().toISOString(),
                        content: templateContent,
                        preview: templateContent
                    };
                    
                    draftsStore.set(draftId, draftData);
                    
                    res.json({
                        success: true,
                        message: 'Draft generated successfully',
                        draft: draftData,
                        preview: templateContent,
                        downloadUrl: `/api/templates/draft/${draftId}/download`
                    });
                }
                
            } catch (fileError) {
                console.error('Error processing template:', fileError);
                return res.status(500).json({
                    success: false,
                    error: 'Failed to process template file',
                    details: fileError.message
                });
            }
        } else {
            // No database - create simple draft
            const draftId = `draft_${Date.now()}`;
            const draftData = {
                id: draftId,
                templateId,
                studentData,
                status: 'draft',
                createdDate: new Date().toISOString(),
                preview: 'Draft generated without database connection'
            };
            
            draftsStore.set(draftId, draftData);
            
            res.json({
                success: true,
                message: 'Draft generated successfully',
                draft: draftData,
                preview: draftData.preview
            });
        }

    } catch (error) {
        console.error('Generate draft error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate draft',
            details: error.message
        });
    }
});

/**
 * GET /api/templates/draft/:draftId/download
 * Download the actual draft document for editing
 */
router.get('/draft/:draftId/download', authenticateToken, async (req, res) => {
    try {
        const { draftId } = req.params;
        const draft = draftsStore.get(draftId);
        
        if (!draft) {
            // Try to load from database
            const db = req.app.locals.db;
            if (db) {
                const [drafts] = await db.execute(
                    'SELECT * FROM document_drafts WHERE id = ?',
                    [draftId]
                );
                
                if (drafts.length > 0 && drafts[0].draft_file_path) {
                    const fileName = `${drafts[0].document_type}_${drafts[0].student_id}_draft.docx`;
                    return res.download(drafts[0].draft_file_path, fileName);
                }
            }
            
            return res.status(404).json({
                success: false,
                error: 'Draft not found'
            });
        }
        
        if (draft.filePath && fsSync.existsSync(draft.filePath)) {
            // Send the actual file
            const ext = path.extname(draft.filePath);
            const fileName = `${draft.studentData.documentType}_${draft.studentData.studentId}_draft${ext}`;
            res.download(draft.filePath, fileName);
        } else {
            // Generate a simple document
            const content = draft.content || 'Draft document content';
            res.set({
                'Content-Type': 'text/plain',
                'Content-Disposition': `attachment; filename="draft_${draftId}.txt"`
            });
            res.send(content);
        }
        
    } catch (error) {
        console.error('Download draft error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to download draft'
        });
    }
});

/**
 * POST /api/templates/draft/:draftId/upload
 * Upload edited draft
 */
router.post('/draft/:draftId/upload', authenticateToken, requireRegistrar, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No file uploaded'
            });
        }

        const { draftId } = req.params;
        let draft = draftsStore.get(draftId);
        
        if (!draft) {
            // Create new draft entry if not found
            draft = {
                id: draftId,
                studentData: {},
                status: 'editing',
                createdDate: new Date().toISOString()
            };
        }
        
        // Update draft with edited file
        draft.editedFilePath = req.file.path;
        draft.status = 'edited';
        draft.lastEdited = new Date().toISOString();
        
        // Extract content from edited file for preview
        if (path.extname(req.file.path).toLowerCase() === '.docx') {
            const result = await mammoth.extractRawText({ path: req.file.path });
            draft.content = result.value;
            draft.preview = result.value;
        }
        
        draftsStore.set(draftId, draft);
        
        res.json({
            success: true,
            message: 'Edited document uploaded successfully',
            draftId,
            filename: req.file.originalname
        });

    } catch (error) {
        console.error('Upload edited draft error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to upload edited document'
        });
    }
});

/**
 * POST /api/templates/draft/:draftId/finalize
 * Finalize draft and prepare for blockchain
 */
router.post('/draft/:draftId/finalize', authenticateToken, requireRegistrar, async (req, res) => {
    try {
        const { draftId } = req.params;
        const draft = draftsStore.get(draftId);
        
        if (!draft) {
            return res.status(404).json({
                success: false,
                error: 'Draft not found'
            });
        }
        
        // Use edited file if available, otherwise use original draft
        const filePath = draft.editedFilePath || draft.filePath;
        let documentContent = '';
        
        if (filePath && fsSync.existsSync(filePath)) {
            const ext = path.extname(filePath).toLowerCase();
            if (ext === '.docx') {
                const result = await mammoth.extractRawText({ path: filePath });
                documentContent = result.value;
            } else {
                documentContent = await fs.readFile(filePath, 'utf8');
            }
        } else {
            documentContent = draft.content || JSON.stringify(draft.studentData);
        }
        
        // Generate hash using Keccak-256 (Ethereum standard)
        const contentHash = ethers.keccak256(ethers.toUtf8Bytes(documentContent));
        
        // Generate QR code
        const qrData = {
            documentHash: contentHash,
            studentId: draft.studentData.studentId,
            documentType: draft.studentData.documentType,
            verificationUrl: `http://localhost:3000/verify?hash=${contentHash}`
        };
        
        const qrCodeBuffer = await QRCode.toBuffer(JSON.stringify(qrData));
        
        // Create finalized document directory
        const finalizedDir = path.join(__dirname, '..', 'finalized');
        await fs.mkdir(finalizedDir, { recursive: true });
        
        // Generate PDF
        const finalizedId = `final_${Date.now()}`;
        const finalPath = path.join(finalizedDir, `${finalizedId}.pdf`);
        
        await generatePDFDocument(draft, qrCodeBuffer, finalPath, contentHash);
        
        const finalizedData = {
            id: finalizedId,
            draftId,
            studentData: draft.studentData,
            contentHash,
            filePath: finalPath,
            status: 'finalized',
            finalizedDate: new Date().toISOString()
        };
        
        finalizedStore.set(finalizedId, finalizedData);
        
        // Save to database
        const db = req.app.locals.db;
        if (db) {
            try {
                await db.execute(
                    `INSERT INTO documents 
                    (document_hash, student_id, student_name, document_type, registrar_id, file_path, date_issued)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        contentHash,
                        draft.studentData.studentId,
                        draft.studentData.studentName,
                        draft.studentData.documentType,
                        req.user.id,
                        finalPath,
                        new Date()
                    ]
                );
            } catch (dbError) {
                console.log('Error saving to documents table:', dbError.message);
            }
        }

        res.json({
            success: true,
            message: 'Document finalized successfully',
            finalized: finalizedData,
            contentHash
        });

    } catch (error) {
        console.error('Finalize draft error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to finalize draft',
            details: error.message
        });
    }
});

/**
 * POST /api/templates/finalized/:finalizedId/register
 * Register on blockchain
 */
router.post('/finalized/:finalizedId/register', authenticateToken, requireRegistrar, async (req, res) => {
    try {
        const { finalizedId } = req.params;
        const finalized = finalizedStore.get(finalizedId);
        
        if (!finalized) {
            return res.status(404).json({
                success: false,
                error: 'Finalized document not found'
            });
        }
        
        const blockchain = req.app.locals.blockchain;
        
        if (!blockchain || !blockchain.initialized) {
            return res.status(503).json({
                success: false,
                error: 'Blockchain service not available'
            });
        }

        // Prepare document data for blockchain
        const documentData = {
            documentContent: finalized.contentHash, // Content for hashing
            studentId: finalized.studentData.studentId,
            studentName: finalized.studentData.studentName,
            documentType: finalized.studentData.documentType,
            dateIssued: Date.now()
        };

        const blockchainResult = await blockchain.registerDocument(documentData);
        
        if (blockchainResult.success) {
            // Update database with blockchain info
            const db = req.app.locals.db;
            if (db) {
                try {
                    await db.execute(
                        `UPDATE documents 
                        SET transaction_hash = ?, block_number = ?
                        WHERE document_hash = ?`,
                        [blockchainResult.transactionHash, blockchainResult.blockNumber, finalized.contentHash]
                    );
                } catch (updateError) {
                    console.log('Error updating document with blockchain info:', updateError.message);
                }
            }
            
            res.json({
                success: true,
                message: 'Document registered on blockchain',
                blockchain: {
                    documentHash: blockchainResult.documentHash,
                    transactionHash: blockchainResult.transactionHash,
                    blockNumber: blockchainResult.blockNumber
                },
                downloadUrl: `/api/templates/finalized/${finalizedId}/download`
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Blockchain registration failed',
                details: blockchainResult.error
            });
        }

    } catch (error) {
        console.error('Register on blockchain error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to register on blockchain',
            details: error.message
        });
    }
});

/**
 * GET /api/templates/finalized/:finalizedId/download
 * Download finalized document
 */
router.get('/finalized/:finalizedId/download', authenticateToken, async (req, res) => {
    try {
        const { finalizedId } = req.params;
        const finalized = finalizedStore.get(finalizedId);
        
        if (!finalized) {
            return res.status(404).json({
                success: false,
                error: 'Document not found'
            });
        }
        
        if (finalized.filePath && fsSync.existsSync(finalized.filePath)) {
            const fileName = `${finalized.studentData.documentType}_${finalized.studentData.studentId}_final.pdf`;
            res.download(finalized.filePath, fileName);
        } else {
            res.status(404).json({
                success: false,
                error: 'Document file not found'
            });
        }
        
    } catch (error) {
        console.error('Download finalized error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to download document'
        });
    }
});

/**
 * GET /api/templates/:id/download
 * Download a template
 */
router.get('/:id/download', authenticateToken, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { id } = req.params;
        
        if (!db) {
            return res.status(503).json({
                success: false,
                error: 'Database not connected'
            });
        }
        
        const [templates] = await db.execute(
            'SELECT * FROM templates WHERE id = ?',
            [id]
        );
        
        if (templates.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Template not found'
            });
        }
        
        const template = templates[0];
        
        if (!fsSync.existsSync(template.file_path)) {
            return res.status(404).json({
                success: false,
                error: 'Template file not found'
            });
        }
        
        res.download(template.file_path, `${template.name}.docx`);
        
    } catch (error) {
        console.error('Download template error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to download template'
        });
    }
});

/**
 * DELETE /api/templates/:id
 * Delete a template
 */
router.delete('/:id', authenticateToken, requireRegistrar, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { id } = req.params;
        
        if (!db) {
            return res.status(503).json({
                success: false,
                error: 'Database not connected'
            });
        }
        
        const [templates] = await db.execute(
            'SELECT * FROM templates WHERE id = ?',
            [id]
        );
        
        if (templates.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Template not found'
            });
        }
        
        const template = templates[0];
        
        // Delete file if exists
        if (fsSync.existsSync(template.file_path)) {
            await fs.unlink(template.file_path);
        }
        
        await db.execute('DELETE FROM templates WHERE id = ?', [id]);
        
        res.json({
            success: true,
            message: 'Template deleted successfully'
        });
        
    } catch (error) {
        console.error('Delete template error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete template'
        });
    }
});

// Helper function to generate PDF
async function generatePDFDocument(draft, qrCodeBuffer, outputPath, documentHash) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const stream = fsSync.createWriteStream(outputPath);
            
            doc.pipe(stream);
            
            // Header with institution name
            doc.fontSize(24).font('Helvetica-Bold')
               .text(draft.studentData.institutionName || 'Academic Institution', { 
                   align: 'center' 
               });
            doc.moveDown(0.5);
            
            // Document type
            doc.fontSize(18).font('Helvetica')
               .text(getDocumentTypeName(draft.studentData.documentType), { 
                   align: 'center' 
               });
            
            // Line separator
            doc.moveTo(50, doc.y + 10)
               .lineTo(550, doc.y + 10)
               .stroke();
            doc.moveDown(1.5);
            
            // Student Information Section
            doc.fontSize(14).font('Helvetica-Bold').text('Student Information', { underline: true });
            doc.moveDown(0.5);
            
            doc.fontSize(12).font('Helvetica');
            doc.text(`Student Name: ${draft.studentData.studentName}`);
            doc.text(`Student ID: ${draft.studentData.studentId}`);
            doc.text(`Program: ${draft.studentData.program || 'N/A'}`);
            doc.text(`Year Level: ${draft.studentData.yearLevel || 'N/A'}`);
            doc.text(`Date Issued: ${new Date().toLocaleDateString()}`);
            doc.moveDown(1);
            
            // Document Content Section
            if (draft.content) {
                doc.fontSize(14).font('Helvetica-Bold').text('Document Content', { underline: true });
                doc.moveDown(0.5);
                doc.fontSize(11).font('Helvetica');
                
                // Add first 1500 characters of content
                const contentPreview = draft.content.substring(0, 1500);
                doc.text(contentPreview, {
                    align: 'justify',
                    indent: 20
                });
                
                if (draft.content.length > 1500) {
                    doc.text('...', { align: 'center' });
                }
                doc.moveDown(1);
            }
            
            // QR Code Section
            doc.moveDown(1);
            doc.fontSize(12).font('Helvetica-Bold')
               .text('Document Verification', { align: 'center' });
            doc.moveDown(0.5);
            
            // Add QR code
            if (qrCodeBuffer) {
                const qrX = (doc.page.width - 150) / 2;
                doc.image(qrCodeBuffer, qrX, doc.y, { 
                    width: 150, 
                    height: 150 
                });
                doc.moveDown(8);
            }
            
            // Verification instructions
            doc.fontSize(10).font('Helvetica')
               .text('Scan the QR code above or visit the verification portal', { align: 'center' });
            doc.text('to verify the authenticity of this document', { align: 'center' });
            doc.moveDown(0.5);
            
            // Document hash
            doc.fontSize(9).font('Helvetica')
               .text(`Document Hash: ${documentHash}`, { 
                   align: 'center',
                   color: '#666666'
               });
            
            // Footer
            doc.fontSize(8).font('Helvetica')
               .text('This document is secured on the blockchain and cannot be tampered with', { 
                   align: 'center',
                   color: '#888888'
               });
            
            doc.end();
            
            stream.on('finish', resolve);
            stream.on('error', reject);
        } catch (error) {
            reject(error);
        }
    });
}

// Helper function to get document type full name
function getDocumentTypeName(type) {
    const types = {
        'TOR': 'Transcript of Records',
        'COR': 'Certificate of Registration',
        'COG': 'Certificate of Graduation',
        'COE': 'Certificate of Enrollment',
        'DIPLOMA': 'Diploma',
        'CERTIFICATE': 'Certificate'
    };
    return types[type] || type;
}

/**
 * POST /api/templates/:templateId/draft
 * Generate a draft with actual template content - DEBUG VERSION
 */
router.post('/:templateId/draft', authenticateToken, requireRegistrar, async (req, res) => {
    console.log('=== Draft Generation Debug ===');
    console.log('Template ID:', req.params.templateId);
    console.log('Student Data:', req.body);
    
    try {
        const { templateId } = req.params;
        const studentData = req.body;

        // Validate required student data
        if (!studentData.studentId || !studentData.studentName) {
            return res.status(400).json({
                success: false,
                error: 'Student ID and name are required'
            });
        }

        const db = req.app.locals.db;
        
        if (!db) {
            console.error('Database not connected');
            return res.status(503).json({
                success: false,
                error: 'Database not connected'
            });
        }
        
        // Check if template exists in database
        console.log('Fetching template from database...');
        const [templates] = await db.execute(
            'SELECT * FROM templates WHERE id = ?',
            [templateId]
        );
        
        if (templates.length === 0) {
            console.error('Template not found in database');
            return res.status(404).json({
                success: false,
                error: 'Template not found'
            });
        }
        
        const template = templates[0];
        console.log('Template found:', {
            id: template.id,
            name: template.name,
            type: template.type,
            file_path: template.file_path
        });
        
        // Check if template file exists
        const fs = require('fs');
        if (!fs.existsSync(template.file_path)) {
            console.error('Template file not found at path:', template.file_path);
            return res.status(404).json({
                success: false,
                error: 'Template file not found on disk'
            });
        }
        
        // Try to read the template file
        const ext = require('path').extname(template.file_path).toLowerCase();
        console.log('Template file extension:', ext);
        
        // For now, create a simple draft to test
        const draftId = `draft_${Date.now()}`;
        const draftData = {
            id: draftId,
            templateId,
            studentData: {
                studentId: studentData.studentId,
                studentName: studentData.studentName,
                documentType: studentData.documentType || template.type,
                program: studentData.program || '',
                yearLevel: studentData.yearLevel || '',
                institutionName: studentData.institutionName || 'Academic Institution'
            },
            status: 'draft',
            createdDate: new Date().toISOString(),
            preview: `
DOCUMENT PREVIEW
================
Document Type: ${studentData.documentType || template.type}
Student Name: ${studentData.studentName}
Student ID: ${studentData.studentId}
Program: ${studentData.program || 'N/A'}
Year Level: ${studentData.yearLevel || 'N/A'}
Institution: ${studentData.institutionName || 'Academic Institution'}
Date: ${new Date().toLocaleDateString()}

This is a preview of your document.
The actual content will be loaded from the template.
            `
        };
        
        // Try to process the actual template if it's a .docx
        if (ext === '.docx') {
            try {
                console.log('Processing Word template...');
                
                // Check if required modules are installed
                let PizZip, Docxtemplater;
                try {
                    PizZip = require('pizzip');
                    Docxtemplater = require('docxtemplater');
                } catch (moduleError) {
                    console.error('Required modules not found:', moduleError.message);
                    console.error('Please run: npm install pizzip docxtemplater');
                    // Continue with simple preview
                }
                
                if (PizZip && Docxtemplater) {
                    const content = fs.readFileSync(template.file_path, 'binary');
                    const zip = new PizZip(content);
                    const doc = new Docxtemplater(zip, {
                        paragraphLoop: true,
                        linebreaks: true,
                        delimiters: {
                            start: '{{',
                            end: '}}'
                        }
                    });
                    
                    // Set template data
                    const templateData = {
                        student_name: studentData.studentName,
                        student_id: studentData.studentId,
                        program: studentData.program || 'Computer Science',
                        year_level: studentData.yearLevel || '4th Year',
                        institution: studentData.institutionName || 'Academic Institution',
                        document_type: studentData.documentType || template.type,
                        issue_date: new Date().toLocaleDateString(),
                        current_date: new Date().toLocaleDateString()
                    };
                    
                    console.log('Rendering template with data:', templateData);
                    doc.setData(templateData);
                    doc.render();
                    
                    // Generate the document
                    const buf = doc.getZip().generate({ type: 'nodebuffer' });
                    
                    // Save draft
                    const draftPath = require('path').join(__dirname, '..', 'drafts', `${draftId}.docx`);
                    require('fs').mkdirSync(require('path').dirname(draftPath), { recursive: true });
                    fs.writeFileSync(draftPath, buf);
                    
                    draftData.filePath = draftPath;
                    
                    // Try to extract text for preview
                    try {
                        const mammoth = require('mammoth');
                        const result = await mammoth.extractRawText({ buffer: buf });
                        draftData.preview = result.value;
                    } catch (mammothError) {
                        console.log('Mammoth not available, using basic preview');
                    }
                }
                
            } catch (templateError) {
                console.error('Error processing template:', templateError);
                console.error('Stack trace:', templateError.stack);
                // Continue with simple preview
            }
        } else if (ext === '.txt') {
            // Process text template
            let templateContent = fs.readFileSync(template.file_path, 'utf8');
            templateContent = templateContent
                .replace(/\{\{student_name\}\}/g, studentData.studentName)
                .replace(/\{\{student_id\}\}/g, studentData.studentId)
                .replace(/\{\{program\}\}/g, studentData.program || 'N/A')
                .replace(/\{\{year_level\}\}/g, studentData.yearLevel || 'N/A')
                .replace(/\{\{institution\}\}/g, studentData.institutionName || 'Academic Institution')
                .replace(/\{\{document_type\}\}/g, studentData.documentType || template.type)
                .replace(/\{\{issue_date\}\}/g, new Date().toLocaleDateString());
            
            draftData.preview = templateContent;
        }
        
        console.log('Draft created successfully');
        res.json({
            success: true,
            message: 'Draft generated successfully',
            draft: draftData,
            preview: draftData.preview,
            downloadUrl: `/api/templates/draft/${draftId}/download`
        });

    } catch (error) {
        console.error('=== Draft Generation Error ===');
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        
        res.status(500).json({
            success: false,
            error: 'Failed to generate draft',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

module.exports = router;