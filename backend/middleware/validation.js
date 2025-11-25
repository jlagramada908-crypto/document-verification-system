const jwt = require('jsonwebtoken');
const { ethers } = require('ethers');

/**
 * Authenticate registrar using JWT token
 */
const authenticateRegistrar = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        error: 'Access denied. No token provided.'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    
    if (decoded.role !== 'registrar') {
      return res.status(403).json({
        error: 'Access denied. Registrar role required.'
      });
    }

    // Verify registrar is still active
    const blockchain = req.app.locals.blockchain;
    const isActive = await blockchain.isActiveRegistrar(decoded.address);
    
    if (!isActive) {
      return res.status(401).json({
        error: 'Registrar access revoked or inactive'
      });
    }

    req.registrar = decoded;
    next();

  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Invalid token'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token expired'
      });
    }

    console.error('Authentication error:', error);
    res.status(500).json({
      error: 'Authentication failed',
      message: error.message
    });
  }
};

/**
 * Authenticate contract owner
 */
const authenticateOwner = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        error: 'Access denied. No token provided.'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    
    // Check if the address is the contract owner
    const blockchain = req.app.locals.blockchain;
    const stats = await blockchain.getContractStats();
    
    if (decoded.address.toLowerCase() !== stats.contractOwner.toLowerCase()) {
      return res.status(403).json({
        error: 'Access denied. Owner privileges required.'
      });
    }

    req.owner = decoded;
    next();

  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Invalid token'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token expired'
      });
    }

    console.error('Owner authentication error:', error);
    res.status(500).json({
      error: 'Authentication failed',
      message: error.message
    });
  }
};

/**
 * Validate document data for registration
 */
const validateDocument = (req, res, next) => {
  const { studentId, studentName, documentType } = req.body;
  
  const errors = [];

  // Student ID validation
  if (!studentId || typeof studentId !== 'string' || studentId.trim() === '') {
    errors.push('Student ID is required and must be a non-empty string');
  } else if (studentId.length > 50) {
    errors.push('Student ID must be 50 characters or less');
  }

  // Student name validation
  if (!studentName || typeof studentName !== 'string' || studentName.trim() === '') {
    errors.push('Student name is required and must be a non-empty string');
  } else if (studentName.length > 100) {
    errors.push('Student name must be 100 characters or less');
  }

  // Document type validation
  const validDocumentTypes = ['COR', 'COG', 'TOR', 'DIPLOMA', 'CERTIFICATE'];
  if (!documentType || !validDocumentTypes.includes(documentType.toUpperCase())) {
    errors.push(`Document type must be one of: ${validDocumentTypes.join(', ')}`);
  }

  // Course data validation (if provided)
  if (req.body.courseData) {
    if (!Array.isArray(req.body.courseData)) {
      errors.push('Course data must be an array');
    } else {
      req.body.courseData.forEach((course, index) => {
        if (!course.courseCode || !course.courseName) {
          errors.push(`Course ${index + 1} must have courseCode and courseName`);
        }
      });
    }
  }

  // Grades validation (if provided)
  if (req.body.grades) {
    if (typeof req.body.grades !== 'object') {
      errors.push('Grades must be an object');
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors
    });
  }

  // Sanitize inputs
  req.body.studentId = studentId.trim();
  req.body.studentName = studentName.trim();
  req.body.documentType = documentType.toUpperCase();

  next();
};

/**
 * Validate verification requests
 */
const validateVerificationRequest = (req, res, next) => {
  const { documentHash } = req.body;

  if (!documentHash) {
    return res.status(400).json({
      error: 'Document hash is required'
    });
  }

  // Validate hash format (should be 32 bytes hex string)
  if (!/^0x[a-fA-F0-9]{64}$/.test(documentHash)) {
    return res.status(400).json({
      error: 'Invalid document hash format'
    });
  }

  next();
};

/**
 * Rate limiting middleware
 */
const createRateLimiter = (windowMs, maxRequests) => {
  const requests = new Map();

  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowStart = now - windowMs;

    // Clean old requests
    if (requests.has(ip)) {
      const ipRequests = requests.get(ip).filter(timestamp => timestamp > windowStart);
      requests.set(ip, ipRequests);
    }

    // Check current requests
    const currentRequests = requests.get(ip) || [];
    
    if (currentRequests.length >= maxRequests) {
      return res.status(429).json({
        error: 'Too many requests',
        message: `Limit of ${maxRequests} requests per ${windowMs / 1000} seconds exceeded`
      });
    }

    // Add current request
    currentRequests.push(now);
    requests.set(ip, currentRequests);

    next();
  };
};

/**
 * Error handling middleware
 */
const errorHandler = (error, req, res, next) => {
  console.error('Error handler:', error);

  // Multer errors (file upload)
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error: 'File too large',
      message: 'Maximum file size is 10MB'
    });
  }

  if (error.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({
      error: 'Too many files',
      message: 'Maximum 10 files allowed'
    });
  }

  if (error.message === 'Only PDF files are allowed') {
    return res.status(400).json({
      error: 'Invalid file type',
      message: 'Only PDF files are allowed'
    });
  }

  // Blockchain errors
  if (error.code === 'CALL_EXCEPTION') {
    return res.status(500).json({
      error: 'Blockchain call failed',
      message: 'Smart contract interaction failed'
    });
  }

  // Default error
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
};

/**
 * Request logging middleware
 */
const requestLogger = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms`);
  });
  
  next();
};

/**
 * CORS configuration for specific origins
 */
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001', 
      'http://127.0.0.1:3000',
      process.env.FRONTEND_URL
    ].filter(Boolean);

    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

module.exports = {
  authenticateRegistrar,
  authenticateOwner,
  validateDocument,
  validateVerificationRequest,
  createRateLimiter,
  errorHandler,
  requestLogger,
  corsOptions
};