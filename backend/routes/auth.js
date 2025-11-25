// routes/auth.js - Updated for PostgreSQL
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = '30m';
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000;

// In-memory storage for login attempts
const loginAttempts = new Map();
const activeSessions = new Map();

// Clean up expired lockouts
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of loginAttempts.entries()) {
        if (data.lockedUntil && data.lockedUntil < now) {
            loginAttempts.delete(key);
        }
    }
}, 60000);

function getAttemptKey(username, ip) {
    return `${username}:${ip}`;
}

function isAccountLocked(username, ip) {
    const key = getAttemptKey(username, ip);
    const attempts = loginAttempts.get(key);
    
    if (!attempts) return false;
    
    if (attempts.lockedUntil && attempts.lockedUntil > Date.now()) {
        return true;
    }
    
    return false;
}

function recordLoginAttempt(username, ip, success = false) {
    const key = getAttemptKey(username, ip);
    
    if (success) {
        loginAttempts.delete(key);
        return;
    }
    
    let attempts = loginAttempts.get(key) || { count: 0, firstAttempt: Date.now() };
    attempts.count++;
    attempts.lastAttempt = Date.now();
    
    if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
        attempts.lockedUntil = Date.now() + LOCKOUT_DURATION;
    }
    
    loginAttempts.set(key, attempts);
    return attempts;
}

function getLockoutTimeRemaining(username, ip) {
    const key = getAttemptKey(username, ip);
    const attempts = loginAttempts.get(key);
    
    if (!attempts || !attempts.lockedUntil) return 0;
    
    const remaining = attempts.lockedUntil - Date.now();
    return Math.max(0, Math.ceil(remaining / 60000));
}

function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

function validatePasswordStrength(password) {
    const minLength = password.length >= 8;
    const hasLetter = /[a-zA-Z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    
    return minLength && hasLetter && hasNumber;
}

function sanitizeInput(input) {
    if (typeof input !== 'string') return input;
    return input.replace(/['"`;\\]/g, '');
}

function getClientIP(req) {
    return req.headers['x-forwarded-for'] || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress ||
           req.ip ||
           'unknown';
}

/**
 * POST /api/auth/admin/login
 */
router.post('/admin/login', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const clientIP = getClientIP(req);
        const userAgent = req.headers['user-agent'] || 'unknown';
        
        let { username, password } = req.body;
        username = sanitizeInput(username);
        
        if (!username || !password) {
            return res.status(400).json({
                success: false,
                error: 'Username and password are required'
            });
        }
        
        if (isAccountLocked(username, clientIP)) {
            const remainingTime = getLockoutTimeRemaining(username, clientIP);
            console.log(`Locked account access attempt: ${username} from ${clientIP}`);
            
            return res.status(429).json({
                success: false,
                error: `Account temporarily locked. Please try again in ${remainingTime} minute${remainingTime > 1 ? 's' : ''}.`,
                lockoutRemaining: remainingTime
            });
        }
        
        // ✅ CHANGED: PostgreSQL query with $1 parameter
        const registrars = await db.query(
            'SELECT * FROM registrars WHERE username = $1 AND is_active = true',
            [username]
        );
        
        if (registrars.rows.length === 0) {
            const attempts = recordLoginAttempt(username, clientIP, false);
            const remainingAttempts = MAX_LOGIN_ATTEMPTS - (attempts.count || 0);
            
            return res.status(401).json({
                success: false,
                error: 'Invalid credentials',
                remainingAttempts: Math.max(0, remainingAttempts)
            });
        }
        
        const registrar = registrars.rows[0];
        
        const isValid = await bcrypt.compare(password, registrar.password);
        
        if (!isValid) {
            const attempts = recordLoginAttempt(username, clientIP, false);
            const remainingAttempts = MAX_LOGIN_ATTEMPTS - attempts.count;
            
            console.log(`Failed login attempt: ${username} from ${clientIP}`);
            
            if (attempts.lockedUntil) {
                const lockoutMinutes = getLockoutTimeRemaining(username, clientIP);
                return res.status(429).json({
                    success: false,
                    error: `Too many failed attempts. Account locked for ${lockoutMinutes} minutes.`,
                    lockoutRemaining: lockoutMinutes
                });
            }
            
            return res.status(401).json({
                success: false,
                error: 'Invalid credentials',
                remainingAttempts: Math.max(0, remainingAttempts)
            });
        }
        
        recordLoginAttempt(username, clientIP, true);
        
        const sessionId = generateSessionToken();
        const token = jwt.sign(
            {
                id: registrar.id,
                username: registrar.username,
                type: 'admin',
                sessionId: sessionId,
                ip: clientIP
            },
            JWT_SECRET,
            { 
                expiresIn: JWT_EXPIRES_IN,
                issuer: 'document-verification-system',
                audience: 'admin-portal'
            }
        );
        
        activeSessions.set(sessionId, {
            registrarId: registrar.id,
            username: registrar.username,
            ip: clientIP,
            userAgent: userAgent,
            loginTime: new Date(),
            lastActivity: new Date(),
            token: crypto.createHash('sha256').update(token).digest('hex')
        });
        
        console.log(`Successful login: ${username} from ${clientIP}`);
        
        res.json({
            success: true,
            message: 'Login successful',
            token,
            user: {
                id: registrar.id,
                username: registrar.username,
                fullName: registrar.full_name,
                institutionName: registrar.institution_name,
                email: registrar.email
            },
            sessionExpiry: new Date(Date.now() + 30 * 60 * 1000)
        });
        
    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({
            success: false,
            error: 'Login failed. Please try again later.'
        });
    }
});

/**
 * POST /api/auth/logout
 * Logout and invalidate session
 */
router.post('/logout', authenticateToken, async (req, res) => {
    try {
        const sessionId = req.user.sessionId;
        
        // Remove active session
        if (sessionId && activeSessions.has(sessionId)) {
            const session = activeSessions.get(sessionId);
            
            // Log logout (would update admin_sessions table in production)
            console.log(`Logout: ${session.username} from ${session.ip}`);
            
            activeSessions.delete(sessionId);
        }
        
        res.json({
            success: true,
            message: 'Logged out successfully'
        });
        
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({
            success: false,
            error: 'Logout failed'
        });
    }
});

/**
 * POST /api/auth/verify-token
 * Verify JWT token is still valid
 */
router.post('/verify-token', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({
                success: false,
                error: 'No token provided'
            });
        }
        
        // Verify token
        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (err) {
                return res.status(403).json({
                    success: false,
                    error: 'Invalid or expired token'
                });
            }
            
            // Check if session is still active
            if (user.sessionId && !activeSessions.has(user.sessionId)) {
                return res.status(403).json({
                    success: false,
                    error: 'Session expired'
                });
            }
            
            // Update last activity
            if (user.sessionId && activeSessions.has(user.sessionId)) {
                const session = activeSessions.get(user.sessionId);
                session.lastActivity = new Date();
                activeSessions.set(user.sessionId, session);
            }
            
            res.json({
                success: true,
                user: {
                    id: user.id,
                    username: user.username,
                    type: user.type
                }
            });
        });
        
    } catch (error) {
        console.error('Token verification error:', error);
        res.status(500).json({
            success: false,
            error: 'Token verification failed'
        });
    }
});

/**
 * POST /api/auth/change-password
 * Change admin password
 */
router.post('/change-password', authenticateToken, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { currentPassword, newPassword } = req.body;
        const userId = req.user.id;
        
        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                error: 'Current and new passwords are required'
            });
        }
        
        if (!validatePasswordStrength(newPassword)) {
            return res.status(400).json({
                success: false,
                error: 'Password must be at least 8 characters and contain both letters and numbers'
            });
        }
        
        // ✅ CHANGED: PostgreSQL query
        const users = await db.query(
            'SELECT * FROM registrars WHERE id = $1',
            [userId]
        );
        
        if (users.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }
        
        const user = users.rows[0];
        
        const isValid = await bcrypt.compare(currentPassword, user.password);
        
        if (!isValid) {
            return res.status(401).json({
                success: false,
                error: 'Current password is incorrect'
            });
        }
        
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        // ✅ CHANGED: PostgreSQL query
        await db.query(
            'UPDATE registrars SET password = $1 WHERE id = $2',
            [hashedPassword, userId]
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

/**
 * Middleware to authenticate token
 */
function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Authentication required'
        });
    }
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({
                success: false,
                error: 'Invalid or expired token'
            });
        }
        
        if (user.sessionId && !activeSessions.has(user.sessionId)) {
            return res.status(403).json({
                success: false,
                error: 'Session expired'
            });
        }
        
        const currentIP = getClientIP(req);
        if (user.ip && user.ip !== currentIP && user.ip !== 'unknown') {
            console.warn(`IP address changed for user ${user.username}: ${user.ip} -> ${currentIP}`);
        }
        
        req.user = user;
        next();
    });
}

/**
 * GET /api/auth/session-info
 * Get current session information
 */
router.get('/session-info', authenticateToken, async (req, res) => {
    try {
        const sessionId = req.user.sessionId;
        const session = activeSessions.get(sessionId);
        
        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Session not found'
            });
        }
        
        res.json({
            success: true,
            session: {
                username: session.username,
                loginTime: session.loginTime,
                lastActivity: session.lastActivity,
                ip: session.ip
            }
        });
        
    } catch (error) {
        console.error('Session info error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get session info'
        });
    }
});

// Export router and middleware
module.exports = router;
module.exports.authenticateToken = authenticateToken;