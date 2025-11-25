// routes/registrars.js - Registrar management routes
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Middleware to verify JWT token
function authenticateToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required'
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'Invalid token'
    });
  }
}

// Middleware to verify registrar
function requireRegistrar(req, res, next) {
  if (req.user.type !== 'registrar') {
    return res.status(403).json({
      success: false,
      error: 'Access denied. Registrar privileges required.'
    });
  }
  next();
}

/**
 * GET /api/registrars/profile
 * Get registrar profile
 */
router.get('/profile', authenticateToken, requireRegistrar, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const blockchain = req.app.locals.blockchain;

    const [registrars] = await db.execute(
      'SELECT id, username, full_name, institution_name, email, wallet_address FROM registrars WHERE id = ?',
      [req.user.id]
    );

    if (registrars.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Registrar not found'
      });
    }

    const registrar = registrars[0];

    // Get blockchain status if wallet address exists
    let blockchainStatus = null;
    if (registrar.wallet_address && blockchain && blockchain.initialized) {
      try {
        const isActive = await blockchain.isActiveRegistrar(registrar.wallet_address);
        const registrarInfo = await blockchain.getRegistrarInfo(registrar.wallet_address);
        blockchainStatus = {
          isActive,
          documentsIssued: registrarInfo.documentsIssued,
          dateAdded: registrarInfo.dateAdded
        };
      } catch (error) {
        console.error('Error fetching blockchain status:', error);
      }
    }

    res.json({
      success: true,
      registrar: {
        ...registrar,
        blockchainStatus
      }
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch profile'
    });
  }
});

/**
 * GET /api/registrars/documents
 * Get documents issued by registrar
 */
router.get('/documents', authenticateToken, requireRegistrar, async (req, res) => {
  try {
    const db = req.app.locals.db;

    const [documents] = await db.execute(
      `SELECT d.*, s.full_name as student_full_name
       FROM documents d
       LEFT JOIN students s ON d.student_id = s.student_id
       WHERE d.registrar_id = ?
       ORDER BY d.created_at DESC`,
      [req.user.id]
    );

    res.json({
      success: true,
      documents
    });

  } catch (error) {
    console.error('Get documents error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch documents'
    });
  }
});

/**
 * GET /api/registrars/requests
 * Get pending document requests
 */
router.get('/requests', authenticateToken, requireRegistrar, async (req, res) => {
  try {
    const db = req.app.locals.db;

    const [requests] = await db.execute(
      `SELECT dr.*, s.full_name as student_name, s.email as student_email
       FROM document_requests dr
       LEFT JOIN students s ON dr.student_id = s.student_id
       WHERE dr.status IN ('pending', 'processing')
       ORDER BY dr.created_at ASC`
    );

    res.json({
      success: true,
      requests
    });

  } catch (error) {
    console.error('Get requests error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch requests'
    });
  }
});

/**
 * POST /api/registrars/requests/:requestId/process
 * Process a document request
 */
router.post('/requests/:requestId/process', authenticateToken, requireRegistrar, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const blockchain = req.app.locals.blockchain;
    const { requestId } = req.params;

    // Get request details
    const [requests] = await db.execute(
      `SELECT dr.*, s.full_name as student_name
       FROM document_requests dr
       LEFT JOIN students s ON dr.student_id = s.student_id
       WHERE dr.id = ? AND dr.status = 'pending'`,
      [requestId]
    );

    if (requests.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Request not found or already processed'
      });
    }

    const request = requests[0];

    // Update request status to processing
    await db.execute(
      `UPDATE document_requests SET status = 'processing', processed_by = ? WHERE id = ?`,
      [req.user.id, requestId]
    );

    // Generate document
    const documentData = {
      studentId: request.student_id,
      studentName: request.student_name,
      documentType: request.document_type,
      dateIssued: Math.floor(Date.now() / 1000)
    };

    // Register on blockchain if available
    let blockchainResult = null;
    let documentHash = null;

    if (blockchain && blockchain.initialized) {
      try {
        documentHash = blockchain.generateDocumentHash(JSON.stringify(documentData));
        
        // Get registrar info
        const [registrars] = await db.execute(
          'SELECT wallet_address, institution_name FROM registrars WHERE id = ?',
          [req.user.id]
        );

        if (registrars[0].wallet_address) {
          blockchainResult = await blockchain.registerDocument(
            documentHash,
            documentData.studentId,
            documentData.studentName,
            documentData.documentType,
            documentData.dateIssued
          );
        }
      } catch (error) {
        console.error('Blockchain registration error:', error);
      }
    }

    // Save document to database
    const [docResult] = await db.execute(
      `INSERT INTO documents (document_hash, student_id, student_name, document_type, institution_name, registrar_id, transaction_hash, block_number, date_issued)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        documentHash || 'pending_hash',
        request.student_id,
        request.student_name,
        request.document_type,
        req.user.institutionName || 'Academic Institution',
        req.user.id,
        blockchainResult?.hash || null,
        blockchainResult?.blockNumber || null,
        new Date()
      ]
    );

    // Update request status to completed
    await db.execute(
      `UPDATE document_requests SET status = 'completed', completed_at = NOW() WHERE id = ?`,
      [requestId]
    );

    res.json({
      success: true,
      message: 'Document request processed successfully',
      document: {
        id: docResult.insertId,
        hash: documentHash,
        transactionHash: blockchainResult?.hash
      }
    });

  } catch (error) {
    console.error('Process request error:', error);
    
    // Update request status back to pending on error
    await req.app.locals.db.execute(
      `UPDATE document_requests SET status = 'pending', processed_by = NULL WHERE id = ?`,
      [req.params.requestId]
    ).catch(console.error);

    res.status(500).json({
      success: false,
      error: 'Failed to process request'
    });
  }
});

/**
 * POST /api/registrars/connect-wallet
 * Connect wallet address to registrar account
 */
router.post('/connect-wallet', authenticateToken, requireRegistrar, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const blockchain = req.app.locals.blockchain;
    const { walletAddress } = req.body;

    if (!walletAddress) {
      return res.status(400).json({
        success: false,
        error: 'Wallet address is required'
      });
    }

    // Validate wallet address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid wallet address format'
      });
    }

    // Update wallet address
    await db.execute(
      'UPDATE registrars SET wallet_address = ? WHERE id = ?',
      [walletAddress, req.user.id]
    );

    // Check if registrar is active on blockchain
    let blockchainStatus = null;
    if (blockchain && blockchain.initialized) {
      try {
        const isActive = await blockchain.isActiveRegistrar(walletAddress);
        if (!isActive) {
          // Note: In production, you'd need owner privileges to add registrar to smart contract
          console.log('Registrar not active on blockchain. Admin needs to add via smart contract.');
        }
        blockchainStatus = { isActive };
      } catch (error) {
        console.error('Error checking blockchain status:', error);
      }
    }

    res.json({
      success: true,
      message: 'Wallet connected successfully',
      walletAddress,
      blockchainStatus
    });

  } catch (error) {
    console.error('Connect wallet error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to connect wallet'
    });
  }
});

/**
 * GET /api/registrars/stats
 * Get registrar statistics
 */
router.get('/stats', authenticateToken, requireRegistrar, async (req, res) => {
  try {
    const db = req.app.locals.db;

    // Get document count
    const [docCount] = await db.execute(
      'SELECT COUNT(*) as count FROM documents WHERE registrar_id = ?',
      [req.user.id]
    );

    // Get pending requests count
    const [pendingCount] = await db.execute(
      'SELECT COUNT(*) as count FROM document_requests WHERE status = "pending"'
    );

    // Get today's documents
    const [todayCount] = await db.execute(
      'SELECT COUNT(*) as count FROM documents WHERE registrar_id = ? AND DATE(created_at) = CURDATE()',
      [req.user.id]
    );

    res.json({
      success: true,
      stats: {
        totalDocuments: docCount[0].count,
        pendingRequests: pendingCount[0].count,
        todayDocuments: todayCount[0].count
      }
    });

  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics'
    });
  }
});

module.exports = router;