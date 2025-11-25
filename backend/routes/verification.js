// routes/verification.js - PostgreSQL Compatible Version
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const { ethers } = require('ethers');
const { PDFDocument } = require('pdf-lib');

// Configure multer for file uploads
const upload = multer({
    dest: 'uploads/temp/',
    limits: { fileSize: 10 * 1024 * 1024 },
});

// ✅ REMOVED: SQLite initialization and ALTER TABLE statements
// PostgreSQL schema changes should be handled in your DatabaseService

// GET /api/verify/:hash - Updated for PostgreSQL
router.get('/:hash', async (req, res) => {
    try {
        const documentHash = req.params.hash;
        
        console.log('Looking up document with hash:', documentHash);
        
        // STEP 1: Check BLOCKCHAIN first (source of truth)
        let blockchainVerified = false;
        let blockchainData = null;
        
        if (req.app.locals.blockchain && req.app.locals.blockchain.initialized) {
            try {
                const blockchainResult = await req.app.locals.blockchain.verifyDocument(documentHash);
                blockchainVerified = blockchainResult.verified;
                blockchainData = blockchainResult.document;
                console.log('Blockchain verification:', blockchainVerified ? '✅ FOUND' : '❌ NOT FOUND');
            } catch (error) {
                console.error('Blockchain verification error:', error);
            }
        } else {
            console.warn('⚠️  Blockchain service not available - using database only');
        }
        
        // STEP 2: Query database for additional metadata
        const db = req.app.locals.db;
        
        // ✅ FIXED: PostgreSQL query
        const result = await db.query('SELECT * FROM documents WHERE document_hash = $1', [documentHash]);
        const document = result.rows[0];

        if (!document && !blockchainVerified) {
            console.log('Document not found in database or blockchain');
            return res.status(404).json({ 
                success: false,
                verified: false,
                error: 'Document not found',
                message: 'This document hash is not in our verification database or blockchain'
            });
        }

        // STEP 3: Return combined result - BLOCKCHAIN is the source of truth
        res.json({
            success: true,
            verified: blockchainVerified,
            document: {
                documentHash: documentHash,
                // Blockchain data (if available)
                ...(blockchainData && {
                    blockchainTimestamp: blockchainData.timestamp,
                    blockchainDate: blockchainData.dateRegistered,
                }),
                // Database metadata (if available)
                ...(document && {
                    studentName: document.student_name,
                    studentId: document.student_id,
                    program: document.program,
                    documentType: document.document_type,
                    dateIssued: document.date_issued,
                    originalFileName: document.original_file_name,
                    createdAt: document.created_at,
                    blockchainTxHash: document.blockchain_tx_hash,
                    blockNumber: document.block_number,
                    hasWatermark: document.verified && document.watermarked_file_path ? true : false
                })
            },
            source: blockchainVerified ? 'blockchain' : 'database_only',
            warning: !blockchainVerified && document ? 
                'This document is in the database but NOT verified on blockchain. It may be a test record.' : null
        });

    } catch (error) {
        console.error('Error verifying document:', error);
        res.status(500).json({ 
            success: false,
            error: 'Verification failed',
            message: error.message 
        });
    }
});

// POST /api/verify/upload - Updated for PostgreSQL
router.post('/upload', upload.single('document'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        console.log('Processing uploaded file:', req.file.originalname, req.file.mimetype);

        // Step 1: Read the uploaded file
        const uploadedBuffer = await fs.readFile(req.file.path);
        
        // Step 2: Calculate Keccak-256 hash of uploaded file content
        const uploadedContentHash = ethers.keccak256(uploadedBuffer);
        console.log('Uploaded file content hash (Keccak-256):', uploadedContentHash);

        // Step 3: Try to extract the embedded document hash from the file
        let embeddedHash = null;
        let isWatermarked = false;
        
        if (req.file.mimetype === 'application/pdf') {
            const extractResult = await extractHashFromPDF(req.file.path);
            embeddedHash = extractResult.hash;
            isWatermarked = extractResult.isWatermarked;
            console.log('Extracted embedded document hash from PDF:', embeddedHash);
            console.log('Is watermarked:', isWatermarked);
        }

        // Step 4: Look up the document in database
        const db = req.app.locals.db;
        let originalDocument = null;
        
        // First try by embedded hash (document metadata hash)
        if (embeddedHash) {
            // ✅ FIXED: PostgreSQL query
            const result = await db.query('SELECT * FROM documents WHERE document_hash = $1', [embeddedHash]);
            originalDocument = result.rows[0];
        }
        
        // If not found by embedded hash, try by content hash (check all variants)
        if (!originalDocument) {
            console.log('Searching by content hash:', uploadedContentHash);
            // ✅ FIXED: PostgreSQL query
            const result = await db.query(`
                SELECT * FROM documents 
                WHERE content_hash = $1 
                   OR processed_content_hash = $2
                   OR watermarked_content_hash = $3
            `, [uploadedContentHash, uploadedContentHash, uploadedContentHash]);
            originalDocument = result.rows[0];
        }

        // If still not found, try fuzzy filename matching
        if (!originalDocument) {
            console.log('No hash match found, attempting filename match...');
            
            let baseName = path.basename(req.file.originalname, path.extname(req.file.originalname));
            baseName = baseName.replace(/[_-]?0x[a-fA-F0-9]+/, '');
            baseName = baseName.replace(/^Verified_/, '');
            
            // ✅ FIXED: PostgreSQL query
            const result = await db.query(`
                SELECT * FROM documents 
                WHERE original_file_name LIKE $1 
                   OR processed_file_path LIKE $2
                   OR watermarked_file_path LIKE $3
                ORDER BY created_at DESC 
                LIMIT 1
            `, [`%${baseName}%`, `%${baseName}%`, `%${baseName}%`]);
            originalDocument = result.rows[0];
        }

        if (!originalDocument) {
            // Clean up and return not found
            await fs.unlink(req.file.path).catch(() => {});
            
            return res.json({
                success: false,
                verificationStatus: 'NOT_FOUND',
                error: 'Document not found in verification database',
                details: 'This document has not been registered in our verification system.',
                uploadedHash: uploadedContentHash,
                suggestions: [
                    'Ensure you are uploading a document that was processed through our system',
                    'Check that you have the correct file',
                    'Contact the issuing institution for verification'
                ]
            });
        }

        // Step 5: CHECK BLOCKCHAIN FIRST!
        console.log('Original document found, checking blockchain verification...');
        
        let blockchainVerified = false;
        let blockchainData = null;
        
        // Check if document is actually on blockchain
        if (req.app.locals.blockchain && req.app.locals.blockchain.initialized) {
            try {
                console.log('Checking blockchain for hash:', originalDocument.document_hash);
                const blockchainResult = await req.app.locals.blockchain.verifyDocument(originalDocument.document_hash);
                blockchainVerified = blockchainResult.verified;
                blockchainData = blockchainResult.document;
                console.log('Blockchain verification:', blockchainVerified ? '✅ FOUND ON BLOCKCHAIN' : '❌ NOT ON BLOCKCHAIN');
            } catch (error) {
                console.error('Blockchain check error:', error);
            }
        }
        
        // If document is NOT on blockchain, it's not truly verified
        if (!blockchainVerified) {
            console.log('⚠️  Document found in database but NOT on blockchain - marking as unverified');
            
            // Clean up uploaded file
            await fs.unlink(req.file.path).catch(() => {});
            
            return res.json({
                success: true,
                verificationStatus: 'NOT_VERIFIED',
                integrity: {
                    authentic: false,
                    message: 'Document found in database but NOT verified on blockchain',
                    tampered: false,
                    confidence: 100,
                    note: 'This document was processed but never registered on blockchain. It may be a test document.',
                    blockchainVerified: false
                },
                document: {
                    documentHash: originalDocument.document_hash,
                    studentName: originalDocument.student_name,
                    studentId: originalDocument.student_id,
                    program: originalDocument.program,
                    documentType: originalDocument.document_type,
                    dateIssued: originalDocument.date_issued,
                    originalFileName: originalDocument.original_file_name,
                    createdAt: originalDocument.created_at,
                    verified: false,
                    blockchainTxHash: null,
                    blockNumber: null,
                    hasWatermark: false
                },
                verificationMethod: 'database_only',
                warning: '⚠️ This document is NOT verified on blockchain. Do not accept as authentic.'
            });
        }
        
        // If we reach here, document IS on blockchain - now check file integrity
        console.log('✅ Document verified on blockchain, checking file integrity...');
        
        let verificationDetails = {};
        
        try {
            // Update content hashes if needed and get all file variants
            await updateDocumentHashes(originalDocument, db);
            
            // Re-fetch document with updated hashes
            const updatedResult = await db.query('SELECT * FROM documents WHERE document_hash = $1', [originalDocument.document_hash]);
            const updatedDocument = updatedResult.rows[0];
            
            // Compare with all known versions
            verificationDetails = await verifyDocumentIntegrity(
                uploadedBuffer,
                uploadedContentHash,
                updatedDocument,
                req.file.mimetype,
                isWatermarked
            );
            
            // Add blockchain verification info
            verificationDetails.blockchainVerified = true;
            verificationDetails.blockchainTimestamp = blockchainData.timestamp;
            
        } catch (error) {
            console.error('Error during file comparison:', error);
            verificationDetails = {
                authentic: false,
                tampered: true,
                message: 'Unable to verify document integrity',
                error: error.message,
                blockchainVerified: true
            };
        }
        
        // Clean up uploaded file
        await fs.unlink(req.file.path).catch(() => {});

        // Return comprehensive verification result
        res.json({
            success: true,
            verificationStatus: verificationDetails.authentic ? 'AUTHENTIC' : 'TAMPERED',
            integrity: verificationDetails,
            document: {
                documentHash: originalDocument.document_hash,
                studentName: originalDocument.student_name,
                studentId: originalDocument.student_id,
                program: originalDocument.program,
                documentType: originalDocument.document_type,
                dateIssued: originalDocument.date_issued,
                originalFileName: originalDocument.original_file_name,
                createdAt: originalDocument.created_at,
                verified: originalDocument.verified || false,
                blockchainTxHash: originalDocument.blockchain_tx_hash,
                blockNumber: originalDocument.block_number,
                hasWatermark: originalDocument.verified && originalDocument.watermarked_file_path ? true : false
            },
            verificationMethod: embeddedHash ? 'document_hash_extraction' : 'content_hash_match',
            uploadedFileType: isWatermarked ? 'watermarked' : 'standard'
        });

    } catch (error) {
        console.error('Error verifying uploaded document:', error);
        
        // Clean up on error
        if (req.file) {
            await fs.unlink(req.file.path).catch(() => {});
        }
        
        res.status(500).json({ 
            error: 'Failed to verify document',
            message: error.message 
        });
    }
});

// Helper function to update document hashes if missing - Updated for PostgreSQL
async function updateDocumentHashes(document, db) {
    const updates = [];
    const params = [];
    
    try {
        // Update processed content hash if missing
        if (!document.processed_content_hash && document.processed_file_path) {
            try {
                const processedBuffer = await fs.readFile(document.processed_file_path);
                const processedHash = ethers.keccak256(processedBuffer);
                updates.push('processed_content_hash = $' + (updates.length + 1));
                params.push(processedHash);
                document.processed_content_hash = processedHash;
            } catch (err) {
                console.log('Could not read processed file:', err.message);
            }
        }
        
        // Update original content hash if missing
        if (!document.content_hash && document.original_file_path) {
            try {
                const originalBuffer = await fs.readFile(document.original_file_path);
                const originalHash = ethers.keccak256(originalBuffer);
                updates.push('content_hash = $' + (updates.length + 1));
                params.push(originalHash);
                document.content_hash = originalHash;
            } catch (err) {
                console.log('Could not read original file:', err.message);
            }
        }
        
        // Update watermarked content hash if missing but file exists
        if (!document.watermarked_content_hash && document.watermarked_file_path) {
            try {
                await fs.access(document.watermarked_file_path);
                const watermarkedBuffer = await fs.readFile(document.watermarked_file_path);
                const watermarkedHash = ethers.keccak256(watermarkedBuffer);
                updates.push('watermarked_content_hash = $' + (updates.length + 1));
                params.push(watermarkedHash);
                document.watermarked_content_hash = watermarkedHash;
            } catch (err) {
                console.log('Could not read watermarked file:', err.message);
            }
        }
        
        // Execute updates if any
        if (updates.length > 0) {
            const sql = `UPDATE documents SET ${updates.join(', ')} WHERE document_hash = $${params.length + 1}`;
            params.push(document.document_hash);
            
            await db.query(sql, params);
        }
    } catch (error) {
        console.error('Error updating document hashes:', error);
    }
}

// Helper function to verify document integrity with watermark awareness (UNCHANGED)
async function verifyDocumentIntegrity(uploadedBuffer, uploadedHash, document, mimeType, isWatermarked) {
    let verificationDetails = {
        authentic: false,
        tampered: true,
        uploadedHash,
        hashMatch: false,
        uploadedSize: uploadedBuffer.length
    };
    
    // Priority order for matching:
    // 1. Watermarked version (if document is verified and watermarked file exists)
    // 2. Processed version (with QR code)
    // 3. Original version (before any modifications)
    
    // Check watermarked version first (highest priority for verified documents)
    if (document.verified && document.watermarked_content_hash && uploadedHash === document.watermarked_content_hash) {
        verificationDetails = {
            authentic: true,
            tampered: false,
            message: 'Document is authentic - Blockchain verified watermarked version',
            confidence: 100,
            hashMatch: true,
            uploadedHash,
            expectedHash: document.watermarked_content_hash,
            note: 'This is the official blockchain-verified version with security watermarks',
            documentType: 'watermarked_verified'
        };
    }
    // Check processed version (with QR code)
    else if (document.processed_content_hash && uploadedHash === document.processed_content_hash) {
        verificationDetails = {
            authentic: true,
            tampered: false,
            message: 'Document is authentic - Processed version with QR verification code',
            confidence: 100,
            hashMatch: true,
            uploadedHash,
            expectedHash: document.processed_content_hash,
            note: document.verified ? 
                'This is the processed version. A watermarked version is available for verified documents.' : 
                'This is the processed version with QR code',
            documentType: 'processed'
        };
    }
    // Check original version (before QR code)
    else if (document.content_hash && uploadedHash === document.content_hash) {
        verificationDetails = {
            authentic: true,
            tampered: false,
            message: 'Document is authentic - Original version (without QR code)',
            confidence: 100,
            hashMatch: true,
            uploadedHash,
            expectedHash: document.content_hash,
            note: 'This is the original document before verification codes were added',
            documentType: 'original'
        };
    }
    else {
        // Document has been tampered with
        verificationDetails = await detectTamperingWithWatermarkAwareness(
            uploadedBuffer,
            uploadedHash,
            document,
            mimeType,
            isWatermarked
        );
    }
    
    return verificationDetails;
}

// Enhanced tampering detection with watermark awareness (UNCHANGED)
async function detectTamperingWithWatermarkAwareness(uploadedBuffer, uploadedHash, document, mimeType, isWatermarked) {
    const uploadedSize = uploadedBuffer.length;
    
    let details = {
        authentic: false,
        tampered: true,
        uploadedHash,
        hashMatch: false,
        uploadedSize,
        isWatermarked
    };
    
    // Determine which version to compare against
    let expectedHash, expectedSize, versionType;
    
    if (document.watermarked_content_hash) {
        expectedHash = document.watermarked_content_hash;
        try {
            const watermarkedBuffer = await fs.readFile(document.watermarked_file_path);
            expectedSize = watermarkedBuffer.length;
            versionType = 'watermarked';
        } catch {
            expectedSize = 0;
        }
    } else if (document.processed_content_hash) {
        expectedHash = document.processed_content_hash;
        try {
            const processedBuffer = await fs.readFile(document.processed_file_path);
            expectedSize = processedBuffer.length;
            versionType = 'processed';
        } catch {
            expectedSize = 0;
        }
    } else if (document.content_hash) {
        expectedHash = document.content_hash;
        try {
            const originalBuffer = await fs.readFile(document.original_file_path);
            expectedSize = originalBuffer.length;
            versionType = 'original';
        } catch {
            expectedSize = 0;
        }
    }
    
    details.expectedHash = expectedHash;
    details.expectedSize = expectedSize;
    details.expectedVersion = versionType;
    
    // Calculate size difference
    const sizeDifference = Math.abs(uploadedSize - expectedSize);
    const sizeRatio = expectedSize > 0 ? sizeDifference / expectedSize : 1;
    
    details.sizeMatch = sizeDifference === 0;
    details.sizeDifference = sizeDifference;
    details.sizeRatio = sizeRatio;
    
    if (mimeType === 'application/pdf') {
        // Enhanced PDF tampering detection
        try {
            const uploadedPdf = await PDFDocument.load(uploadedBuffer);
            const uploadedPageCount = uploadedPdf.getPageCount();
            
            // Try to load expected PDF for comparison
            let expectedPdf, expectedPageCount;
            if (versionType === 'watermarked' && document.watermarked_file_path) {
                try {
                    const expectedBuffer = await fs.readFile(document.watermarked_file_path);
                    expectedPdf = await PDFDocument.load(expectedBuffer);
                    expectedPageCount = expectedPdf.getPageCount();
                } catch (e) {
                    console.log('Could not load watermarked PDF for comparison');
                }
            }
            
            if (expectedPageCount && uploadedPageCount !== expectedPageCount) {
                details.message = `TAMPERED: Page count mismatch (uploaded: ${uploadedPageCount}, expected: ${expectedPageCount})`;
                details.tamperType = 'PAGE_MODIFICATION';
                details.confidence = 100;
            } else if (isWatermarked && versionType !== 'watermarked') {
                details.message = 'POTENTIALLY TAMPERED: Uploaded file appears watermarked but doesn\'t match watermarked version';
                details.tamperType = 'WATERMARK_MISMATCH';
                details.confidence = 85;
                details.note = 'File contains watermark-like elements but hash doesn\'t match official watermarked version';
            } else if (!isWatermarked && versionType === 'watermarked') {
                details.message = 'TAMPERED: Watermark removed or modified';
                details.tamperType = 'WATERMARK_REMOVAL';
                details.confidence = 95;
            } else if (sizeRatio < 0.01) {
                details.message = 'POSSIBLY TAMPERED: Minor modifications detected (possibly metadata changes)';
                details.tamperType = 'MINOR_MODIFICATION';
                details.confidence = 70;
            } else {
                details.message = `TAMPERED: Content has been modified (${Math.round(sizeRatio * 100)}% size difference)`;
                details.tamperType = 'CONTENT_MODIFICATION';
                details.confidence = 95;
            }
            
        } catch (error) {
            details.message = 'TAMPERED: Document structure has been corrupted or significantly altered';
            details.tamperType = 'STRUCTURE_CORRUPTION';
            details.confidence = 100;
        }
    } else {
        // For other file types
        if (sizeDifference === 0) {
            details.message = 'TAMPERED: File size matches but content differs (sophisticated tampering)';
            details.tamperType = 'CONTENT_REPLACEMENT';
            details.confidence = 100;
        } else if (sizeRatio < 0.05) {
            details.message = 'TAMPERED: Minor modifications detected';
            details.tamperType = 'MINOR_MODIFICATION';
            details.confidence = 85;
        } else {
            details.message = `TAMPERED: Significant modifications detected (${Math.round(sizeRatio * 100)}% size difference)`;
            details.tamperType = 'MAJOR_MODIFICATION';
            details.confidence = 100;
        }
    }
    
    // Add hash algorithm info
    details.hashAlgorithm = 'Keccak-256 (Ethereum standard)';
    
    return details;
}

// Enhanced helper function to extract hash from PDF and detect watermarks (UNCHANGED)
async function extractHashFromPDF(pdfPath) {
    try {
        const pdfBytes = await fs.readFile(pdfPath);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        
        let documentHash = null;
        let isWatermarked = false;
        
        // Check PDF metadata for document hash
        const subject = pdfDoc.getSubject();
        if (subject && subject.startsWith('0x')) {
            documentHash = subject;
        }
        
        // Check if it's a verified document (watermarked)
        if (subject && subject.includes('Verified:')) {
            isWatermarked = true;
            // Extract hash from verified subject
            const hashMatch = subject.match(/(0x[a-fA-F0-9]{64})/);
            if (hashMatch) {
                documentHash = hashMatch[1];
            }
        }
        
        // Check keywords
        const keywords = pdfDoc.getKeywords();
        if (keywords) {
            const hashMatch = keywords.match(/verification_hash:(0x[a-fA-F0-9]{64})/);
            if (hashMatch) {
                documentHash = hashMatch[1];
            }
            
            // Check for watermark indicators
            if (keywords.includes('blockchain_verified:true')) {
                isWatermarked = true;
            }
        }
        
        return {
            hash: documentHash,
            isWatermarked
        };
        
    } catch (error) {
        console.error('PDF hash extraction error:', error);
        return {
            hash: null,
            isWatermarked: false
        };
    }
}

module.exports = router;