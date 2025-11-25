// routes/documents.js - Enhanced with watermarking functionality
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const QRCode = require('qrcode');
const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const sharp = require('sharp');
const { ethers } = require('ethers');
const mammoth = require('mammoth');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);


// Configure multer for file uploads
const upload = multer({
    dest: 'uploads/temp/',
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});



// Watermark configuration
const WATERMARK_CONFIG = {
    text: 'BLOCKCHAIN VERIFIED',
    opacity: 0.3,
    fontSize: 24,
    rotation: -45,
    color: { r: 0, g: 0.5, b: 1 }, // Blue color
    position: 'diagonal' // 'diagonal', 'center', 'corners'
};

// QR Configuration (unchanged)
const QR_CONFIG = {
    pdf: {
        position: 'bottom-right',
        margin: 30,
        scale: 0.5,
        background: true,
        borderWidth: 1
    }
};

// Position calculation helper function (unchanged)
function calculateQRPosition(dimensions, qrDimensions, position, margin = 30) {
    const { width, height } = dimensions;
    const { width: qrWidth, height: qrHeight } = qrDimensions;
    
    switch (position) {
        case 'top-left':
            return { x: margin, y: height - qrHeight - margin };
        case 'top-right':
            return { x: width - qrWidth - margin, y: height - qrHeight - margin };
        case 'bottom-left':
            return { x: margin, y: margin };
        case 'bottom-right':
            return { x: width - qrWidth - margin, y: margin };
        case 'center':
            return { x: (width - qrWidth) / 2, y: (height - qrHeight) / 2 };
        default:
            return { x: width - qrWidth - margin, y: margin }; // default bottom-right
    }
}

// POST /api/documents/process - Updated for PostgreSQL
router.post('/process', upload.single('document'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const { student_name, student_id, program, document_type } = req.body;
        
        const documentData = {
            student_name,
            student_id,
            program,
            document_type,
            date_issued: new Date().toISOString(),
            original_file_name: req.file.originalname
        };

        const document_hash = ethers.keccak256(
            ethers.toUtf8Bytes(JSON.stringify(documentData))
        );

        // Create verification URL
        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const verificationUrl = `${baseUrl}/verify/${document_hash}`;

        // Generate QR code
        const qrCodeBuffer = await QRCode.toBuffer(verificationUrl, {
            width: 200,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            }
        });

        // Store original file
        const originalStoragePath = path.join('uploads', 'originals', document_hash + path.extname(req.file.originalname));
        await fs.mkdir(path.dirname(originalStoragePath), { recursive: true });
        await fs.copyFile(req.file.path, originalStoragePath);

        // Process document with QR
        let processed_file_path;
        if (req.file.mimetype === 'application/pdf') {
            processed_file_path = await embedQRInPDF(req.file.path, qrCodeBuffer, document_hash);
        } else if (req.file.mimetype.startsWith('image/')) {
            processed_file_path = await embedQRInImage(req.file.path, qrCodeBuffer, document_hash);
        } else if (req.file.originalname.endsWith('.docx')) {
            processed_file_path = await createPDFFromWord(req.file.path, qrCodeBuffer, documentData, document_hash);
        } else {
            processed_file_path = await createCoverPagePDF(documentData, qrCodeBuffer, document_hash);
        }

        // ✅ FIXED: PostgreSQL query with proper parameter syntax
        const db = req.app.locals.db;
        const insertResult = await db.query(
            `INSERT INTO documents 
            (document_hash, student_name, student_id, program, document_type, date_issued, 
             original_file_name, processed_file_path, original_file_path, watermarked_file_path) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id`,
            [
                document_hash, 
                student_name, 
                student_id, 
                program, 
                document_type, 
                documentData.date_issued, 
                req.file.originalname, 
                processed_file_path, 
                originalStoragePath, 
                null
            ]
        );

        // Clean up temp file
        await fs.unlink(req.file.path);

        res.json({
            success: true,
            document_hash,
            processedFile: processed_file_path,
            previewUrl: `/api/documents/preview/${path.basename(processed_file_path)}`,
            downloadUrl: `/api/documents/download/${path.basename(processed_file_path)}`,
            verificationUrl,
            documentData
        });

    } catch (error) {
        console.error('Error processing document:', error);
        if (req.file) await fs.unlink(req.file.path).catch(() => {});
        res.status(500).json({ error: 'Failed to process document' });
    }
});

// POST /api/documents/finalize - Updated for PostgreSQL
router.post('/finalize', async (req, res) => {
    try {
        const { document_hash, documentData } = req.body;
        
        console.log('=== Starting document finalization ===');
        console.log('Document hash:', document_hash);
        
        if (!document_hash) {
            return res.status(400).json({ error: 'Document hash is required' });
        }
        
        const blockchain = req.app.locals.blockchain;
        const db = req.app.locals.db;
        
        if (!blockchain || !blockchain.initialized) {
            console.log('Blockchain not available, simulating for testing...');
            
            // ✅ FIXED: PostgreSQL query
            const result = await db.query('SELECT * FROM documents WHERE document_hash = $1', [document_hash]);
            const document = result.rows[0];

            if (!document) {
                throw new Error('Document not found');
            }
            
            console.log('Creating watermarked document (simulation mode)...');
            
            // Create watermarked version
            let watermarked_file_path = null;
            try {
                const simulatedResult = {
                    transactionHash: '0x' + Math.random().toString(16).substr(2, 64),
                    block_number: Math.floor(Math.random() * 1000000)
                };
                
                const watermarkData = {
                    txHash: simulatedResult.transactionHash,
                    block_number: simulatedResult.block_number,
                    timestamp: new Date().toISOString(),
                    verified: true
                };
                
                watermarked_file_path = await createWatermarkedDocument(
                    document.processed_file_path, 
                    document_hash,
                    watermarkData
                );
                
                console.log('Watermarked file created at:', watermarked_file_path);
                await fs.access(watermarked_file_path);
                console.log('Watermarked file verified to exist');
                
            } catch (watermarkError) {
                console.error('Watermarking failed:', watermarkError);
                return res.status(500).json({ 
                    error: 'Failed to create watermarked document',
                    details: watermarkError.message 
                });
            }
            
            // ✅ FIXED: PostgreSQL update query
            await db.query(
                `UPDATE documents 
                 SET blockchain_tx_hash = $1, block_number = $2, verified = true, watermarked_file_path = $3
                 WHERE document_hash = $4`,
                [simulatedResult.transactionHash, simulatedResult.block_number, watermarked_file_path, document_hash]
            );
            
            console.log('Database updated with watermark path');
            
            // ✅ FIXED: PostgreSQL verification query
            const verifyResult = await db.query(
                'SELECT watermarked_file_path, verified FROM documents WHERE document_hash = $1', 
                [document_hash]
            );
            const updatedDoc = verifyResult.rows[0];
            
            console.log('Verification - Updated document:', updatedDoc);
            
            return res.json({
                success: true,
                transactionHash: simulatedResult.transactionHash,
                block_number: simulatedResult.block_number,
                watermarkedFile: watermarked_file_path,
                message: 'Document verified (simulation mode - blockchain not connected)',
                verified: true
            });
        }
        
        // ✅ FIXED: PostgreSQL query to get document
        const result = await db.query('SELECT * FROM documents WHERE document_hash = $1', [document_hash]);
        const document = result.rows[0];
        
        if (!document) {
            throw new Error('Document not found in database');
        }
        
        console.log('Document found:', {
            hash: document.document_hash,
            processedPath: document.processed_file_path,
            currentlyVerified: document.verified
        });
        
        // Check if already verified
        if (document.verified && document.blockchain_tx_hash && document.watermarked_file_path) {
            try {
                await fs.access(document.watermarked_file_path);
                console.log('Document already verified and watermarked file exists');
                
                return res.json({
                    success: true,
                    message: 'Document already verified on blockchain',
                    transactionHash: document.blockchain_tx_hash,
                    block_number: document.block_number,
                    watermarkedFile: document.watermarked_file_path,
                    verified: true
                });
            } catch (err) {
                console.log('Watermarked file missing, will recreate...');
            }
        }
        
        console.log('Registering document on blockchain...');
        
        // Register on blockchain
        const blockchainResult = await blockchain.registerDocument({
            documentContent: document_hash
        });
        
        if (!blockchainResult.success) {
            console.error('Blockchain registration failed:', blockchainResult);
            return res.status(500).json({ 
                error: 'Blockchain registration failed',
                details: blockchainResult.error || 'Unknown blockchain error'
            });
        }
        
        console.log('Blockchain registration successful:', blockchainResult.transactionHash);
        
        // Create watermarked directory
        const watermarkedDir = path.join('uploads', 'watermarked');
        await fs.mkdir(watermarkedDir, { recursive: true });
        console.log('Ensured watermarked directory exists');
        
        // Create watermarked version
        let watermarked_file_path = null;
        try {
            const watermarkData = {
                txHash: blockchainResult.transactionHash,
                block_number: blockchainResult.block_number,
                timestamp: new Date().toISOString(),
                verified: true
            };
            
            console.log('Creating watermarked document with data:', watermarkData);
            
            watermarked_file_path = await createWatermarkedDocument(
                document.processed_file_path, 
                document_hash,
                watermarkData
            );
            
            console.log('Watermarked document created at:', watermarked_file_path);
            const stats = await fs.stat(watermarked_file_path);
            console.log('Watermarked file size:', stats.size, 'bytes');
            
        } catch (watermarkError) {
            console.error('Failed to create watermark:', watermarkError);
            console.error('Full watermark error:', watermarkError.stack);
        }
        
        // ✅ FIXED: PostgreSQL update query
        if (watermarked_file_path) {
            await db.query(
                `UPDATE documents 
                 SET blockchain_tx_hash = $1, block_number = $2, verified = true, watermarked_file_path = $3
                 WHERE document_hash = $4`,
                [blockchainResult.transactionHash, blockchainResult.block_number, watermarked_file_path, document_hash]
            );
        } else {
            await db.query(
                `UPDATE documents 
                 SET blockchain_tx_hash = $1, block_number = $2, verified = true
                 WHERE document_hash = $3`,
                [blockchainResult.transactionHash, blockchainResult.block_number, document_hash]
            );
        }
        
        console.log('Database updated successfully');
        console.log('=== Document finalization completed ===');
        
        res.json({
            success: true,
            transactionHash: blockchainResult.transactionHash,
            block_number: blockchainResult.block_number,
            watermarkedFile: watermarked_file_path,
            message: 'Document successfully verified on blockchain',
            verified: true
        });
        
    } catch (error) {
        console.error('Error in /api/documents/finalize:', error);
        console.error('Full error stack:', error.stack);
        res.status(500).json({ 
            error: 'Failed to finalize document',
            message: error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// GET /api/documents/view-original/:hash - Updated for PostgreSQL
router.get('/view-original/:hash', async (req, res) => {
    try {
        const document_hash = req.params.hash;
        
        console.log('=== View Original Document Request ===');
        console.log('Document hash:', document_hash);
        
        // ✅ FIXED: PostgreSQL query
        const db = req.app.locals.db;
        const result = await db.query('SELECT * FROM documents WHERE document_hash = $1', [document_hash]);
        const document = result.rows[0];

        if (!document) {
            console.log('Document not found in database');
            return res.status(404).json({ error: 'Document not found' });
        }

        console.log('Document details:', {
            hash: document_hash,
            verified: document.verified,
            hasWatermarkPath: !!document.watermarked_file_path,
            watermarkPath: document.watermarked_file_path,
            processedPath: document.processed_file_path,
            originalPath: document.original_file_path
        });

        // Determine which file to serve (file selection logic remains the same)
        let filePath = null;
        let fileType = 'unknown';
        
        if (document.verified && document.watermarked_file_path) {
            console.log('Document is verified, checking for watermarked file...');
            try {
                await fs.access(document.watermarked_file_path);
                filePath = document.watermarked_file_path;
                fileType = 'watermarked';
                console.log('✓ SERVING WATERMARKED VERSION (Original Stamped Copy)');
            } catch (err) {
                console.error('WARNING: Watermarked file path exists in DB but file not found:', document.watermarked_file_path);
                // Fallback logic remains the same...
            }
        }
        
        // Fallback logic remains the same...
        if (!filePath && document.processed_file_path) {
            try {
                await fs.access(document.processed_file_path);
                filePath = document.processed_file_path;
                fileType = 'processed';
                console.log('Serving processed document (with QR code)');
            } catch (err) {
                console.log('Processed file not found');
            }
        }
        
        if (!filePath && document.original_file_path) {
            try {
                await fs.access(document.original_file_path);
                filePath = document.original_file_path;
                fileType = 'original';
                console.log('Serving original document (no modifications)');
            } catch (err) {
                console.log('Original file not found');
            }
        }
        
        if (!filePath) {
            console.error('No accessible file found for document');
            return res.status(404).json({ 
                error: 'Document file not available',
                details: 'No version of this document exists on the server'
            });
        }

        // Get file extension for content type
        const ext = path.extname(filePath).toLowerCase();
        let contentType = 'application/octet-stream';
        
        switch(ext) {
            case '.pdf':
                contentType = 'application/pdf';
                break;
            case '.jpg':
            case '.jpeg':
                contentType = 'image/jpeg';
                break;
            case '.png':
                contentType = 'image/png';
                break;
        }

        console.log(`Serving ${fileType} file: ${filePath}`);
        console.log('=== End View Original Document ===');

        // Set headers
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${document.original_file_name}"`);
        res.removeHeader('X-Frame-Options');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'self' http://localhost:* https://localhost:*");
        res.setHeader('X-Document-Type', fileType);
        res.setHeader('X-Document-Verified', document.verified ? 'true' : 'false');
        res.setHeader('X-Watermarked', fileType === 'watermarked' ? 'true' : 'false');
        
        // Send the file
        res.sendFile(path.resolve(filePath));

    } catch (error) {
        console.error('Error serving document:', error);
        res.status(500).json({ error: 'Failed to load document', details: error.message });
    }
});

// Keep existing preview and download routes unchanged
router.get('/preview/:filename', (req, res) => {
    const filePath = path.join('uploads', 'processed', req.params.filename);
    
    fs.access(filePath)
        .then(() => {
            res.setHeader('Content-Disposition', 'inline');
            res.sendFile(path.resolve(filePath));
        })
        .catch(() => {
            res.status(404).json({ error: 'Preview file not found' });
        });
});

router.get('/download/:filename', (req, res) => {
    const filePath = path.join('uploads', 'processed', req.params.filename);
    
    fs.access(filePath)
        .then(() => {
            res.download(path.resolve(filePath));
        })
        .catch(() => {
            res.status(404).json({ error: 'Download file not found' });
        });
});

// WATERMARKING FUNCTIONS

// Fixed watermarking function with better error handling
async function createWatermarkedDocument(processed_file_path, document_hash, watermarkData) {
    try {
        console.log('createWatermarkedDocument called with:', {
            processed_file_path,
            document_hash,
            watermarkData
        });
        
        // Check if processed file exists
        await fs.access(processed_file_path);
        console.log('Processed file exists:', processed_file_path);
        
        const ext = path.extname(processed_file_path).toLowerCase();
        const watermarkedPath = path.join('uploads', 'watermarked', `${document_hash}_verified${ext}`);
        
        // Create watermarked directory if it doesn't exist
        await fs.mkdir(path.dirname(watermarkedPath), { recursive: true });
        console.log('Watermarked directory ensured');
        
        if (ext === '.pdf') {
            console.log('Processing PDF for watermarking...');
            return await addWatermarkToPDF(processed_file_path, watermarkedPath, watermarkData);
        } else if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
            console.log('Processing image for watermarking...');
            return await addWatermarkToImage(processed_file_path, watermarkedPath, watermarkData);
        } else {
            console.log('Unsupported format for watermarking, copying file...');
            // For unsupported formats, just copy the file
            await fs.copyFile(processed_file_path, watermarkedPath);
            return watermarkedPath;
        }
    } catch (error) {
        console.error('Error in createWatermarkedDocument:', error);
        throw error;
    }
}

// Fixed PDF watermarking function
async function addWatermarkToPDF(inputPath, outputPath, watermarkData) {
    try {
        console.log('Starting PDF watermarking with stamp style...');
        console.log('Input path:', inputPath);
        console.log('Output path:', outputPath);
        
        const existingPdfBytes = await fs.readFile(inputPath);
        const pdfDoc = await PDFDocument.load(existingPdfBytes, { ignoreEncryption: true });
        const pages = pdfDoc.getPages();
        
        // Embed fonts
        const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
        
        console.log(`Adding stamp watermark to ${pages.length} pages...`);
        
        // Apply watermark to each page
        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const { width, height } = page.getSize();
            
            console.log(`Processing page ${i + 1}: ${width}x${height}`);
            
            // CENTER STAMP WATERMARK
            const centerX = width / 2;
            const centerY = height / 2;
            
            // Create circular stamp background
            const stampRadius = 120;
            
            // Remove circles - only keep subtle white background for text readability
            page.drawCircle({
                x: centerX,
                y: centerY,
                size: stampRadius - 15,
                color: rgb(1, 1, 1),
                opacity: 0.1  // Keep this very light
            });
            
            // Main "ORIGINAL" text in the center - REDUCED OPACITY
            const mainText = 'ORIGINAL';
            const mainFontSize = 36;
            const mainTextWidth = boldFont.widthOfTextAtSize(mainText, mainFontSize);
            
            page.drawText(mainText, {
                x: centerX - (mainTextWidth / 2),
                y: centerY + 15,  // Moved up slightly to center between the two lines
                size: mainFontSize,
                font: boldFont,
                color: rgb(0.8, 0, 0),
                opacity: 0.2
            });
            
            // "COPY" text below - REDUCED OPACITY
            const copyText = 'COPY';
            const copyFontSize = 28;
            const copyTextWidth = boldFont.widthOfTextAtSize(copyText, copyFontSize);
            
            page.drawText(copyText, {
                x: centerX - (copyTextWidth / 2),
                y: centerY - 15,  // Moved down slightly to center between the two lines
                size: copyFontSize,
                font: boldFont,
                color: rgb(0.8, 0, 0),
                opacity: 0.2
            });
            
            // Horizontal lines above and below text - REDUCED OPACITY - ADJUSTED FOR CENTERING
            page.drawLine({
                start: { x: centerX - 70, y: centerY + 45 },  // Moved up to accommodate centered text
                end: { x: centerX + 70, y: centerY + 45 },
                thickness: 2,
                color: rgb(0.8, 0, 0),
                opacity: 0.18
            });
            
            page.drawLine({
                start: { x: centerX - 70, y: centerY - 45 },  // Moved down to accommodate centered text
                end: { x: centerX + 70, y: centerY - 45 },
                thickness: 2,
                color: rgb(0.8, 0, 0),
                opacity: 0.18
            });
            
            // Add "DO NOT MODIFY" around expanded circle - MOVED FURTHER OUT AND BRIGHTER
            const circularText = 'DO NOT MODIFY • BLOCKCHAIN VERIFIED •';
            const letterFontSize = 11;
            const angleStep = 360 / circularText.length;
            const expandedRadius = stampRadius + 40; // Moved 40 points further out
            
            for (let j = 0; j < circularText.length; j++) {
                const angle = (j * angleStep) - 90; // Start from top
                const radian = (angle * Math.PI) / 180;
                const letterX = centerX + Math.cos(radian) * expandedRadius;
                const letterY = centerY + Math.sin(radian) * expandedRadius;
                
                page.drawText(circularText[j], {
                    x: letterX - 3,
                    y: letterY - 3,
                    size: letterFontSize,
                    font: regularFont,
                    color: rgb(0.6, 0, 0),
                    opacity: 0.25,  // Increased from 0.15 to 0.25 to make it brighter
                    rotate: degrees(angle + 90)
                });
            }
            
            // Add verification date inside stamp at bottom - REDUCED OPACITY
            const dateText = new Date(watermarkData.timestamp).toLocaleDateString();
            const dateFontSize = 10;
            const dateTextWidth = regularFont.widthOfTextAtSize(dateText, dateFontSize);
            
            page.drawText(dateText, {
                x: centerX - (dateTextWidth / 2),
                y: centerY - 60,
                size: dateFontSize,
                font: regularFont,
                color: rgb(0.5, 0, 0),
                opacity: 0.2  // Reduced from 0.6 to 0.2
            });
            
            
            // BOTTOM TRANSACTION INFO - REDUCED OPACITY
            const txText = `Transaction: ${watermarkData.txHash.substring(0, 16)}...${watermarkData.txHash.substring(watermarkData.txHash.length - 8)}`;
            const txFontSize = 8;
            const txTextWidth = regularFont.widthOfTextAtSize(txText, txFontSize);
            
            page.drawRectangle({
                x: (width / 2) - (txTextWidth / 2) - 10,
                y: 15,
                width: txTextWidth + 20,
                height: 18,
                color: rgb(0.95, 0.95, 0.95),
                borderColor: rgb(0.7, 0.7, 0.7),
                borderWidth: 0.5,
                opacity: 0.3  // Reduced from 0.8 to 0.3
            });
            
            page.drawText(txText, {
                x: (width / 2) - (txTextWidth / 2),
                y: 20,
                size: txFontSize,
                font: regularFont,
                color: rgb(0.4, 0.4, 0.4),
                opacity: 0.5  // Added opacity to make text more subtle
            });
        }
        
        // Update PDF metadata
        pdfDoc.setSubject(`Blockchain Verified: ${watermarkData.txHash}`);
        pdfDoc.setKeywords([
            `verification_hash:${watermarkData.txHash}`,
            `block_number:${watermarkData.block_number}`,
            'blockchain_verified:true',
            'watermarked:true',
            'original_copy:stamped'
        ]);
        pdfDoc.setProducer('Document Verification System - Original Stamped Copy');
        pdfDoc.setCreationDate(new Date());
        pdfDoc.setModificationDate(new Date());
        pdfDoc.setTitle(`ORIGINAL - Blockchain Verified`);
        
        const pdfBytes = await pdfDoc.save();
        await fs.writeFile(outputPath, pdfBytes);
        
        // Verify the file was created and has content
        const stats = await fs.stat(outputPath);
        console.log(`✓ Watermarked PDF created successfully: ${outputPath}`);
        console.log(`  File size: ${stats.size} bytes`);
        console.log(`  Stamp watermark applied: ORIGINAL COPY (Subtle opacity)`);
        
        return outputPath;
        
    } catch (error) {
        console.error('Error adding watermark to PDF:', error);
        console.error('Error details:', error.message);
        throw error;
    }
}

// Keep the existing addWatermarkToImage function but add error handling
async function addWatermarkToImage(inputPath, outputPath, watermarkData) {
    try {
        console.log('Starting image watermarking...');
        
        const image = sharp(inputPath);
        const metadata = await image.metadata();
        
        if (!metadata.width || !metadata.height) {
            throw new Error('Invalid image metadata');
        }
        
        const { width, height } = metadata;
        
        // Create a more visible watermark SVG
        const watermarkSvg = Buffer.from(`
            <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <!-- Define a pattern for repeating watermark -->
                    <pattern id="watermarkPattern" x="0" y="0" width="400" height="400" patternUnits="userSpaceOnUse">
                        <text x="200" y="200" 
                              font-family="Arial, sans-serif" 
                              font-size="42" 
                              font-weight="bold" 
                              fill="rgba(200, 50, 50, 0.3)" 
                              text-anchor="middle"
                              transform="rotate(-45 200 200)">
                            ORIGINAL COPY
                        </text>
                        <text x="200" y="240" 
                              font-family="Arial, sans-serif" 
                              font-size="42" 
                              font-weight="bold" 
                              fill="rgba(200, 50, 50, 0.3)" 
                              text-anchor="middle"
                              transform="rotate(-45 200 240)">
                            DO NOT MODIFY
                        </text>
                    </pattern>
                </defs>
                
                <!-- Apply the pattern across the entire image -->
                <rect width="100%" height="100%" fill="url(#watermarkPattern)" />
                
                <!-- Verification badge at top-right -->
                <g transform="translate(${width - 180}, 20)">
                    <rect width="160" height="35" rx="5" 
                          fill="rgba(0, 150, 0, 0.85)" 
                          stroke="rgba(0, 100, 0, 1)" 
                          stroke-width="2"/>
                    <text x="80" y="23" 
                          font-family="Arial, sans-serif" 
                          font-size="14" 
                          font-weight="bold" 
                          fill="white" 
                          text-anchor="middle">
                        BLOCKCHAIN VERIFIED
                    </text>
                </g>
                
                <!-- Block info at bottom -->
                <text x="${width / 2}" y="${height - 20}" 
                      font-family="Arial, sans-serif" 
                      font-size="12" 
                      fill="rgba(0, 100, 0, 0.8)" 
                      text-anchor="middle"
                      font-weight="bold">
                    Block #${watermarkData.block_number} | Verified: ${new Date(watermarkData.timestamp).toLocaleDateString()}
                </text>
            </svg>
        `);
        
        // Apply watermark with proper blending
        const watermarkedImage = await image
            .composite([{
                input: watermarkSvg,
                top: 0,
                left: 0,
                blend: 'over'
            }])
            .toBuffer();
        
        await fs.writeFile(outputPath, watermarkedImage);
        
        const stats = await fs.stat(outputPath);
        console.log(`✓ Watermarked image created successfully: ${outputPath}`);
        console.log(`  File size: ${stats.size} bytes`);
        
        return outputPath;
        
    } catch (error) {
        console.error('Error adding watermark to image:', error);
        throw error;
    }
}

// Keep all existing helper functions (embedQRInPDF, embedQRInImage, etc.) unchanged
// ... [Previous helper functions remain the same] ...

// Helper function: Embed QR code in PDF (unchanged)
async function embedQRInPDF(pdfPath, qrCodeBuffer, document_hash) {
    try {
        const existingPdfBytes = await fs.readFile(pdfPath);
        const pdfDoc = await PDFDocument.load(existingPdfBytes);
        
        pdfDoc.setSubject(document_hash);
        pdfDoc.setKeywords([`verification_hash:${document_hash}`]);
        pdfDoc.setProducer('Document Verification System');
        
        const qrImage = await pdfDoc.embedPng(qrCodeBuffer);
        const qrDims = qrImage.scale(QR_CONFIG.pdf.scale);
        
        const pages = pdfDoc.getPages();
        const firstPage = pages[0];
        const { width, height } = firstPage.getSize();
        
        const position = calculateQRPosition(
            { width, height }, 
            qrDims, 
            QR_CONFIG.pdf.position, 
            QR_CONFIG.pdf.margin
        );
        
        if (QR_CONFIG.pdf.background) {
            firstPage.drawRectangle({
                x: position.x - 8,
                y: position.y - 8,
                width: qrDims.width + 16,
                height: qrDims.height + 35,
                color: rgb(1, 1, 1),
                borderColor: rgb(0.8, 0.8, 0.8),
                borderWidth: QR_CONFIG.pdf.borderWidth
            });
        }
        
        firstPage.drawImage(qrImage, {
            x: position.x,
            y: position.y + 20,
            width: qrDims.width,
            height: qrDims.height,
        });
        
        firstPage.drawText('Scan to Verify', {
            x: position.x + (qrDims.width / 2) - 30,
            y: position.y + 5,
            size: 9,
            color: rgb(0.3, 0.3, 0.3)
        });
        
        firstPage.drawText(`Hash: ${document_hash.substring(0, 20)}...`, {
            x: 30,
            y: 15,
            size: 6,
            color: rgb(0.5, 0.5, 0.5)
        });
        
        const modifiedPdfBytes = await pdfDoc.save();
        const outputPath = path.join('uploads', 'processed', `${document_hash}.pdf`);
        
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, modifiedPdfBytes);
        
        return outputPath;
        
    } catch (error) {
        console.error('Error embedding QR in PDF:', error);
        throw error;
    }
}

// Helper function: Embed QR code in image (unchanged)
async function embedQRInImage(imagePath, qrCodeBuffer, document_hash) {
    try {
        const image = sharp(imagePath);
        const metadata = await image.metadata();
        
        const qrBackground = await sharp({
            create: {
                width: 220,
                height: 220,
                channels: 4,
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            }
        })
        .composite([{
            input: qrCodeBuffer,
            top: 10,
            left: 10
        }])
        .png()
        .toBuffer();
        
        const qrPosition = {
            top: metadata.height - 240,
            left: metadata.width - 240
        };
        
        const outputBuffer = await image
            .composite([{
                input: qrBackground,
                top: Math.max(20, qrPosition.top),
                left: Math.max(20, qrPosition.left)
            }])
            .toBuffer();
        
        const outputPath = path.join('uploads', 'processed', `${document_hash}.png`);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, outputBuffer);
        
        return outputPath;
        
    } catch (error) {
        console.error('Error embedding QR in image:', error);
        throw error;
    }
}

// Add these missing functions to your documents.js file

// Enhanced Word to PDF conversion with multiple fallback options
async function createPDFFromWord(wordPath, qrCodeBuffer, documentData, document_hash) {
    try {
        console.log('Converting Word document to PDF...');
        
        // Try Method 1: LibreOffice (if installed)
        try {
            return await convertWithLibreOffice(wordPath, qrCodeBuffer, document_hash);
        } catch (libreOfficeError) {
            console.log('LibreOffice conversion failed:', libreOfficeError.message);
            console.log('Trying alternative method...');
        }
        
        // Try Method 2: mammoth.js for DOCX text extraction
        if (wordPath.toLowerCase().endsWith('.docx')) {
            try {
                return await convertWithMammoth(wordPath, qrCodeBuffer, documentData, document_hash);
            } catch (mammothError) {
                console.log('Mammoth conversion failed:', mammothError.message);
                console.log('Falling back to basic PDF creation...');
            }
        }
        
        // Method 3: Create basic PDF with document info (final fallback)
        return await createBasicPDFFromWord(wordPath, qrCodeBuffer, documentData, document_hash);
        
    } catch (error) {
        console.error('All conversion methods failed:', error);
        throw error;
    }
}

// Method 1: LibreOffice conversion (FIXED VERSION)
async function convertWithLibreOffice(wordPath, qrCodeBuffer, document_hash) {
    // Check for common LibreOffice installation paths on Windows
    const possiblePaths = [
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
        'soffice.exe', // If in PATH
        'soffice' // For Linux/Mac
    ];
    
    let sofficeCommand = null;
    
    // Test which LibreOffice path works
    for (const testPath of possiblePaths) {
        try {
            // Test the path by checking if file exists (for Windows) or running version command
            if (testPath.includes(':\\')) {
                // Windows absolute path - check if file exists
                await fs.access(testPath);
                sofficeCommand = `"${testPath}"`;
                console.log(`Found LibreOffice at: ${testPath}`);
                break;
            } else {
                // Command in PATH - test with version
                const testCmd = `${testPath} --version`;
                await execPromise(testCmd, { timeout: 5000 });
                sofficeCommand = testPath;
                console.log(`Found LibreOffice command: ${testPath}`);
                break;
            }
        } catch (err) {
            console.log(`LibreOffice not found at: ${testPath}`);
            continue;
        }
    }
    
    if (!sofficeCommand) {
        // Try to find LibreOffice in common directories
        const searchDirs = [
            'C:\\Program Files\\LibreOffice',
            'C:\\Program Files (x86)\\LibreOffice'
        ];
        
        for (const dir of searchDirs) {
            try {
                const sofficeExe = path.join(dir, 'program', 'soffice.exe');
                await fs.access(sofficeExe);
                sofficeCommand = `"${sofficeExe}"`;
                console.log(`Found LibreOffice at: ${sofficeExe}`);
                break;
            } catch (err) {
                continue;
            }
        }
    }
    
    if (!sofficeCommand) {
        throw new Error('LibreOffice installation not found. Please ensure LibreOffice is properly installed.');
    }
    
    // Create temp directory
    const tempDir = path.join('uploads', 'temp');
    await fs.mkdir(tempDir, { recursive: true });
    
    const outputDir = path.resolve(tempDir);
    const inputFile = path.resolve(wordPath);
    
    console.log('LibreOffice conversion details:');
    console.log('- Command:', sofficeCommand);
    console.log('- Input file:', inputFile);
    console.log('- Output directory:', outputDir);
    
    // LibreOffice conversion command
    const command = `${sofficeCommand} --headless --convert-to pdf --outdir "${outputDir}" "${inputFile}"`;
    console.log('- Full command:', command);
    
    try {
        console.log('Executing LibreOffice conversion...');
        const { stdout, stderr } = await execPromise(command, { 
            timeout: 60000, // 60 second timeout
            cwd: process.cwd() // Set working directory
        });
        
        console.log('LibreOffice conversion completed successfully');
        if (stdout) console.log('Stdout:', stdout);
        if (stderr) console.log('Stderr:', stderr);
        
    } catch (error) {
        console.error('LibreOffice execution failed:', error.message);
        console.error('Command that failed:', command);
        throw new Error(`LibreOffice conversion failed: ${error.message}`);
    }
    
    // Find the output PDF file
    const pdfFileName = path.basename(wordPath, path.extname(wordPath)) + '.pdf';
    const tempPdfPath = path.join(tempDir, pdfFileName);
    
    // Check if conversion was successful
    try {
        await fs.access(tempPdfPath);
        console.log('PDF created successfully');
    } catch {
        throw new Error('PDF file was not created by LibreOffice');
    }
    
    // Add QR code to the converted PDF
    const finalPdfPath = await addQRToExistingPDF(tempPdfPath, qrCodeBuffer, document_hash);
    
    // Clean up temp file
    await fs.unlink(tempPdfPath).catch(console.error);
    
    return finalPdfPath;
}

// Method 2: Use mammoth.js to extract text and create PDF
async function convertWithMammoth(wordPath, qrCodeBuffer, documentData, document_hash) {
    console.log('Converting DOCX using mammoth.js...');
    
    const wordBuffer = await fs.readFile(wordPath);
    
    // Extract text from DOCX
    const result = await mammoth.extractRawText({ buffer: wordBuffer });
    const extractedText = result.value;
    
    if (!extractedText || extractedText.trim().length === 0) {
        throw new Error('No text content found in Word document');
    }
    
    console.log(`Extracted ${extractedText.length} characters from Word document`);
    
    // Create PDF with extracted text
    const pdfDoc = await PDFDocument.create();
    let page = pdfDoc.addPage();
    const { width, height } = page.getSize();
    
    // Embed font
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    // Add document header
    page.drawText('CONVERTED WORD DOCUMENT', {
        x: 50,
        y: height - 50,
        size: 20,
        font: boldFont,
        color: rgb(0, 0, 0.8)
    });
    
    // Add document metadata
    let yPosition = height - 90;
    const metadata = [
        `Student: ${documentData.student_name}`,
        `ID: ${documentData.student_id}`,
        `Program: ${documentData.program}`,
        `Document Type: ${documentData.document_type}`,
        `Original File: ${documentData.original_file_name}`,
        `Conversion Date: ${new Date().toLocaleDateString()}`
    ];
    
    metadata.forEach(line => {
        page.drawText(line, {
            x: 50,
            y: yPosition,
            size: 12,
            font: font,
            color: rgb(0, 0, 0)
        });
        yPosition -= 20;
    });
    
    // Add separator line
    yPosition -= 10;
    page.drawLine({
        start: { x: 50, y: yPosition },
        end: { x: width - 50, y: yPosition },
        thickness: 1,
        color: rgb(0.5, 0.5, 0.5)
    });
    yPosition -= 30;
    
    // Add extracted text with word wrapping
    const maxLineWidth = width - 100;
    const fontSize = 11;
    const lineHeight = 16;
    
    const words = extractedText.split(/\s+/);
    let currentLine = '';
    
    for (const word of words) {
        const testLine = currentLine + (currentLine ? ' ' : '') + word;
        const testWidth = font.widthOfTextAtSize(testLine, fontSize);
        
        if (testWidth > maxLineWidth && currentLine) {
            // Draw current line and start new one
            page.drawText(currentLine, {
                x: 50,
                y: yPosition,
                size: fontSize,
                font: font,
                color: rgb(0, 0, 0)
            });
            yPosition -= lineHeight;
            currentLine = word;
            
            // Check if we need a new page
            if (yPosition < 100) {
                page = pdfDoc.addPage();
                yPosition = height - 50;
            }
        } else {
            currentLine = testLine;
        }
    }
    
    // Draw the last line
    if (currentLine) {
        page.drawText(currentLine, {
            x: 50,
            y: yPosition,
            size: fontSize,
            font: font,
            color: rgb(0, 0, 0)
        });
    }
    
    // Add QR code to the first page
    const firstPage = pdfDoc.getPages()[0];
    const qrImage = await pdfDoc.embedPng(qrCodeBuffer);
    const qrDims = qrImage.scale(0.4);
    
    const qrX = width - qrDims.width - 30;
    const qrY = 30;
    
    // White background for QR
    firstPage.drawRectangle({
        x: qrX - 5,
        y: qrY - 5,
        width: qrDims.width + 10,
        height: qrDims.height + 25,
        color: rgb(1, 1, 1),
        borderColor: rgb(0.8, 0.8, 0.8),
        borderWidth: 1
    });
    
    firstPage.drawImage(qrImage, {
        x: qrX,
        y: qrY + 15,
        width: qrDims.width,
        height: qrDims.height
    });
    
    firstPage.drawText('Scan to Verify', {
        x: qrX + (qrDims.width / 2) - 30,
        y: qrY,
        size: 8,
        font: font,
        color: rgb(0.3, 0.3, 0.3)
    });
    
    // Set PDF metadata
    pdfDoc.setSubject(document_hash);
    pdfDoc.setKeywords([`verification_hash:${document_hash}`]);
    pdfDoc.setProducer('Document Verification System - DOCX Conversion');
    pdfDoc.setTitle(`${documentData.document_type} - ${documentData.student_name}`);
    
    // Save PDF
    const pdfBytes = await pdfDoc.save();
    const outputPath = path.join('uploads', 'processed', `${document_hash}.pdf`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, pdfBytes);
    
    console.log(`✓ DOCX converted to PDF using mammoth.js: ${outputPath}`);
    return outputPath;
}

// Method 3: Basic PDF creation (final fallback)
async function createBasicPDFFromWord(wordPath, qrCodeBuffer, documentData, document_hash) {
    console.log('Creating basic PDF with document information...');
    
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage();
    const { width, height } = page.getSize();
    
    // Embed fonts
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    // Title
    page.drawText('DOCUMENT VERIFICATION CERTIFICATE', {
        x: 50,
        y: height - 50,
        size: 18,
        font: boldFont,
        color: rgb(0, 0, 0.8)
    });
    
    // Notice about conversion
    page.drawRectangle({
        x: 40,
        y: height - 120,
        width: width - 80,
        height: 40,
        color: rgb(1, 0.95, 0.8),
        borderColor: rgb(1, 0.7, 0),
        borderWidth: 1
    });
    
    page.drawText('Note: This certificate represents a Word document that could not be fully converted.', {
        x: 50,
        y: height - 95,
        size: 11,
        font: font,
        color: rgb(0.6, 0.3, 0)
    });
    
    page.drawText('The original file is preserved and can be downloaded separately.', {
        x: 50,
        y: height - 110,
        size: 11,
        font: font,
        color: rgb(0.6, 0.3, 0)
    });
    
    // Document details
    let yPosition = height - 160;
    const details = [
        `Document Type: ${documentData.document_type}`,
        `Student Name: ${documentData.student_name}`,
        `Student ID: ${documentData.student_id}`,
        `Program: ${documentData.program}`,
        `Date Issued: ${new Date(documentData.date_issued).toLocaleDateString()}`,
        `Original File: ${documentData.original_file_name}`,
        `File Size: ${await getFileSize(wordPath)}`
    ];
    
    details.forEach(detail => {
        page.drawText(detail, {
            x: 50,
            y: yPosition,
            size: 12,
            font: font,
            color: rgb(0, 0, 0)
        });
        yPosition -= 25;
    });
    
    // QR Code
    const qrImage = await pdfDoc.embedPng(qrCodeBuffer);
    const qrDims = qrImage.scale(0.8);
    
    page.drawImage(qrImage, {
        x: (width - qrDims.width) / 2,
        y: 180,
        width: qrDims.width,
        height: qrDims.height
    });
    
    page.drawText('Scan QR code to verify document authenticity', {
        x: (width - 200) / 2,
        y: 150,
        size: 12,
        font: font,
        color: rgb(0, 0, 0)
    });
    
    // Instructions
    page.drawText('VERIFICATION INSTRUCTIONS:', {
        x: 50,
        y: 110,
        size: 12,
        font: boldFont,
        color: rgb(0, 0, 0)
    });
    
    const instructions = [
        '1. Scan the QR code above with your mobile device',
        '2. Or visit the verification portal online',
        '3. The original Word document can be downloaded from the verification page'
    ];
    
    yPosition = 85;
    instructions.forEach(instruction => {
        page.drawText(instruction, {
            x: 50,
            y: yPosition,
            size: 10,
            font: font,
            color: rgb(0.3, 0.3, 0.3)
        });
        yPosition -= 15;
    });
    
    // Document hash
    page.drawText(`Document Hash: ${document_hash}`, {
        x: 50,
        y: 20,
        size: 8,
        font: font,
        color: rgb(0.5, 0.5, 0.5)
    });
    
    // Set PDF metadata
    pdfDoc.setSubject(document_hash);
    pdfDoc.setKeywords([`verification_hash:${document_hash}`]);
    pdfDoc.setProducer('Document Verification System - Basic Conversion');
    pdfDoc.setTitle(`Certificate - ${documentData.student_name}`);
    
    const pdfBytes = await pdfDoc.save();
    const outputPath = path.join('uploads', 'processed', `${document_hash}.pdf`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, pdfBytes);
    
    console.log(`✓ Basic PDF certificate created: ${outputPath}`);
    return outputPath;
}

// Helper function to add QR to existing PDF
async function addQRToExistingPDF(pdfPath, qrCodeBuffer, document_hash) {
    const existingPdfBytes = await fs.readFile(pdfPath);
    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    
    // Add metadata
    pdfDoc.setSubject(document_hash);
    pdfDoc.setKeywords([`verification_hash:${document_hash}`]);
    pdfDoc.setProducer('Document Verification System');
    
    // Get the first page
    const pages = pdfDoc.getPages();
    if (pages.length === 0) {
        throw new Error('PDF has no pages');
    }
    
    const firstPage = pages[0];
    const { width, height } = firstPage.getSize();
    
    // Embed QR code
    const qrImage = await pdfDoc.embedPng(qrCodeBuffer);
    const qrDims = qrImage.scale(0.4);
    
    // Position QR code at bottom-right
    const qrX = width - qrDims.width - 30;
    const qrY = 30;
    
    // White background for QR
    firstPage.drawRectangle({
        x: qrX - 5,
        y: qrY - 5,
        width: qrDims.width + 10,
        height: qrDims.height + 30,
        color: rgb(1, 1, 1),
        borderColor: rgb(0.8, 0.8, 0.8),
        borderWidth: 1,
        opacity: 0.95
    });
    
    // Draw QR code
    firstPage.drawImage(qrImage, {
        x: qrX,
        y: qrY + 15,
        width: qrDims.width,
        height: qrDims.height
    });
    
    // Add "Scan to Verify" text
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    firstPage.drawText('Scan to Verify', {
        x: qrX + (qrDims.width / 2) - 30,
        y: qrY,
        size: 8,
        font: font,
        color: rgb(0.3, 0.3, 0.3)
    });
    
    // Save the final PDF
    const pdfBytes = await pdfDoc.save();
    const outputPath = path.join('uploads', 'processed', `${document_hash}.pdf`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, pdfBytes);
    
    return outputPath;
}

// Helper function to get file size
async function getFileSize(filePath) {
    try {
        const stats = await fs.stat(filePath);
        const sizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
        return `${sizeInMB} MB`;
    } catch {
        return 'Unknown';
    }
}

// Helper function: Create cover page PDF with QR
async function createCoverPagePDF(documentData, qrCodeBuffer, document_hash) {
    try {
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage();
        const { width, height } = page.getSize();
        
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        
        // Title
        page.drawText('DOCUMENT VERIFICATION CERTIFICATE', {
            x: 50,
            y: height - 50,
            size: 18,
            font: boldFont,
            color: rgb(0, 0, 0.8)
        });
        
        // Document details
        const details = [
            `Document Type: ${documentData.document_type}`,
            `Student Name: ${documentData.student_name}`,
            `Student ID: ${documentData.student_id}`,
            `Program: ${documentData.program}`,
            `Date Issued: ${new Date(documentData.date_issued).toLocaleDateString()}`,
            `Original File: ${documentData.original_file_name}`
        ];
        
        let yPosition = height - 120;
        details.forEach(detail => {
            page.drawText(detail, {
                x: 50,
                y: yPosition,
                size: 12,
                font: font,
                color: rgb(0, 0, 0)
            });
            yPosition -= 25;
        });
        
        // QR Code
        const qrImage = await pdfDoc.embedPng(qrCodeBuffer);
        const qrDims = qrImage.scale(1);
        
        page.drawImage(qrImage, {
            x: (width - qrDims.width) / 2,
            y: 150,
            width: qrDims.width,
            height: qrDims.height
        });
        
        // Verification instructions
        page.drawText('VERIFICATION INSTRUCTIONS', {
            x: 50,
            y: 120,
            size: 12,
            font: boldFont,
            color: rgb(0, 0, 0)
        });
        
        page.drawText('Scan the QR code above or visit the verification portal', {
            x: 50,
            y: 95,
            size: 10,
            font: font,
            color: rgb(0.3, 0.3, 0.3)
        });
        
        // Document hash
        page.drawText(`Document Hash: ${document_hash}`, {
            x: 50,
            y: 30,
            size: 8,
            font: font,
            color: rgb(0.5, 0.5, 0.5)
        });
        
        const pdfBytes = await pdfDoc.save();
        const outputPath = path.join('uploads', 'processed', `${document_hash}.pdf`);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, pdfBytes);
        
        return outputPath;
        
    } catch (error) {
        console.error('Error creating cover page PDF:', error);
        throw error;
    }
}

// Backend - Add this simpler protected route to documents.js
// GET /api/documents/view-protected/:hash - Updated for PostgreSQL
router.get('/view-protected/:hash', async (req, res) => {
    try {
        const document_hash = req.params.hash;
        const db = req.app.locals.db;
        
        // ✅ FIXED: PostgreSQL query
        const result = await db.query('SELECT * FROM documents WHERE document_hash = $1', [document_hash]);
        const document = result.rows[0];

        if (!document) {
            return res.status(404).json({ error: 'Document not found' });
        }

        // File selection logic (same as before)
        let filePath = null;
        
        if (document.verified && document.watermarked_file_path) {
            try {
                await fs.access(document.watermarked_file_path);
                filePath = document.watermarked_file_path;
            } catch (err) {
                if (document.processed_file_path) {
                    try {
                        await fs.access(document.processed_file_path);
                        filePath = document.processed_file_path;
                    } catch (err2) {}
                }
            }
        } else if (document.processed_file_path) {
            try {
                await fs.access(document.processed_file_path);
                filePath = document.processed_file_path;
            } catch (err) {}
        }

        if (!filePath) {
            return res.status(404).json({ error: 'Document file not available' });
        }

        const ext = path.extname(filePath).toLowerCase();
        let contentType = 'application/pdf';
        
        if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
        if (ext === '.png') contentType = 'image/png';

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', 'inline');
        
        res.sendFile(path.resolve(filePath));

    } catch (error) {
        console.error('Error serving document:', error);
        res.status(500).json({ error: 'Failed to load document' });
    }
});

// GET /api/documents/test-libreoffice - Test LibreOffice installation
router.get('/test-libreoffice', async (req, res) => {
    try {
        console.log('=== LibreOffice Installation Test ===');
        
        const results = {
            tests: [],
            found: false,
            workingPath: null,
            error: null
        };
        
        // Test paths
        const possiblePaths = [
            'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
            'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
            'soffice.exe',
            'soffice'
        ];
        
        for (const testPath of possiblePaths) {
            const test = { path: testPath, exists: false, executable: false };
            
            try {
                if (testPath.includes(':\\')) {
                    // Windows absolute path - check if file exists
                    await fs.access(testPath);
                    test.exists = true;
                    
                    // Test if it's executable
                    const testCmd = `"${testPath}" --version`;
                    const { stdout } = await execPromise(testCmd, { timeout: 10000 });
                    test.executable = true;
                    test.version = stdout.trim();
                    
                    if (!results.found) {
                        results.found = true;
                        results.workingPath = testPath;
                    }
                } else {
                    // Command in PATH - test with version
                    const testCmd = `${testPath} --version`;
                    const { stdout } = await execPromise(testCmd, { timeout: 10000 });
                    test.exists = true;
                    test.executable = true;
                    test.version = stdout.trim();
                    
                    if (!results.found) {
                        results.found = true;
                        results.workingPath = testPath;
                    }
                }
            } catch (error) {
                test.error = error.message;
            }
            
            results.tests.push(test);
        }
        
        console.log('LibreOffice test results:', results);
        
        res.json({
            success: true,
            libreOfficeFound: results.found,
            workingPath: results.workingPath,
            testResults: results.tests,
            recommendation: results.found ? 
                'LibreOffice is properly installed and accessible.' :
                'LibreOffice not found. Please ensure it is installed correctly.',
            systemInfo: {
                platform: process.platform,
                arch: process.arch,
                nodeVersion: process.version
            }
        });
        
    } catch (error) {
        console.error('LibreOffice test error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to test LibreOffice installation',
            details: error.message
        });
    }
});


module.exports = router;