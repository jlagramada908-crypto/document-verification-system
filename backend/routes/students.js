// routes/students.js - Complete Student management routes
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
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

/**
 * POST /api/students/login
 * Student login
 */
router.post('/login', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { studentId, password } = req.body;

    if (!studentId || !password) {
      return res.status(400).json({
        success: false,
        error: 'Student ID and password are required'
      });
    }

    // Find student
    const [students] = await db.execute(
      'SELECT * FROM students WHERE student_id = ? AND is_active = true',
      [studentId]
    );

    if (students.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    const student = students[0];

    // Verify password
    const isValid = await bcrypt.compare(password, student.password);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        id: student.id,
        studentId: student.student_id,
        type: 'student'
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      token,
      student: {
        id: student.id,
        studentId: student.student_id,
        fullName: student.full_name,
        email: student.email,
        program: student.program,
        yearLevel: student.year_level
      }
    });

  } catch (error) {
    console.error('Student login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});

/**
 * GET /api/students/profile
 * Get student profile
 */
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'student') {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const db = req.app.locals.db;
    const [students] = await db.execute(
      'SELECT id, student_id, full_name, email, program, year_level FROM students WHERE id = ?',
      [req.user.id]
    );

    if (students.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Student not found'
      });
    }

    res.json({
      success: true,
      student: students[0]
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
 * GET /api/students/:studentId
 * Get student by ID (for registrars)
 */
router.get('/:studentId', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'registrar') {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const db = req.app.locals.db;
    const { studentId } = req.params;

    const [students] = await db.execute(
      'SELECT id, student_id, full_name, email, program, year_level FROM students WHERE student_id = ?',
      [studentId]
    );

    if (students.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Student not found'
      });
    }

    res.json({
      success: true,
      student: students[0]
    });

  } catch (error) {
    console.error('Get student error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch student'
    });
  }
});

/**
 * GET /api/students/documents/my
 * Get student's own documents
 */
router.get('/documents/my', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'student') {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const db = req.app.locals.db;
    const blockchain = req.app.locals.blockchain;

    // Get student info
    const [students] = await db.execute(
      'SELECT student_id FROM students WHERE id = ?',
      [req.user.id]
    );

    if (students.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Student not found'
      });
    }

    const studentId = students[0].student_id;

    // Get documents from database
    const [documents] = await db.execute(
      'SELECT * FROM documents WHERE student_id = ? ORDER BY created_at DESC',
      [studentId]
    );

    // If blockchain is connected, get on-chain documents too
    let blockchainDocs = [];
    if (blockchain && blockchain.initialized) {
      try {
        blockchainDocs = await blockchain.getStudentDocuments(studentId);
      } catch (error) {
        console.error('Error fetching blockchain documents:', error);
      }
    }

    res.json({
      success: true,
      documents,
      blockchainDocuments: blockchainDocs
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
 * POST /api/students/request-document
 * Request a new document
 */
router.post('/request-document', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'student') {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const db = req.app.locals.db;
    const { documentType, purpose } = req.body;

    if (!documentType) {
      return res.status(400).json({
        success: false,
        error: 'Document type is required'
      });
    }

    // Get student ID
    const [students] = await db.execute(
      'SELECT student_id FROM students WHERE id = ?',
      [req.user.id]
    );

    if (students.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Student not found'
      });
    }

    const studentId = students[0].student_id;

    // Insert document request
    const [result] = await db.execute(
      `INSERT INTO document_requests (student_id, document_type, purpose, status)
       VALUES (?, ?, ?, 'pending')`,
      [studentId, documentType, purpose || null]
    );

    res.json({
      success: true,
      message: 'Document request submitted successfully',
      requestId: result.insertId
    });

  } catch (error) {
    console.error('Request document error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit document request'
    });
  }
});

/**
 * GET /api/students/requests/my
 * Get student's document requests
 */
router.get('/requests/my', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'student') {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const db = req.app.locals.db;

    // Get student ID
    const [students] = await db.execute(
      'SELECT student_id FROM students WHERE id = ?',
      [req.user.id]
    );

    if (students.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Student not found'
      });
    }

    const studentId = students[0].student_id;

    // Get requests
    const [requests] = await db.execute(
      `SELECT dr.*, r.full_name as processed_by_name
       FROM document_requests dr
       LEFT JOIN registrars r ON dr.processed_by = r.id
       WHERE dr.student_id = ?
       ORDER BY dr.created_at DESC`,
      [studentId]
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
 * POST /api/students/change-password
 * Change student password
 */
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'student') {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const db = req.app.locals.db;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Current password and new password are required'
      });
    }

    // Validate new password (must be 6 digits)
    if (!/^\d{6}$/.test(newPassword)) {
      return res.status(400).json({
        success: false,
        error: 'Password must be exactly 6 digits'
      });
    }

    // Get student
    const [students] = await db.execute(
      'SELECT * FROM students WHERE id = ?',
      [req.user.id]
    );

    if (students.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Student not found'
      });
    }

    const student = students[0];

    // Verify current password
    const isValid = await bcrypt.compare(currentPassword, student.password);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        error: 'Current password is incorrect'
      });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    await db.execute(
      'UPDATE students SET password = ? WHERE id = ?',
      [hashedPassword, req.user.id]
    );

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to change password'
    });
  }
});

module.exports = router;