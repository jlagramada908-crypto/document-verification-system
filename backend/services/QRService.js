const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

class QRService {

  /**
   * Generate QR code as buffer
   * @param {string} data - Data to encode in QR code
   * @param {Object} options - QR code options
   * @returns {Promise<Buffer>} - QR code image buffer
   */
  static async generateQR(data, options = {}) {
    try {
      const defaultOptions = {
        type: 'png',
        quality: 0.92,
        margin: 1,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        width: 256,
        errorCorrectionLevel: 'M'
      };

      const qrOptions = { ...defaultOptions, ...options };
      const qrBuffer = await QRCode.toBuffer(data, qrOptions);
      return qrBuffer;
    } catch (error) {
      console.error('Error generating QR code:', error);
      throw new Error('Failed to generate QR code');
    }
  }

  /**
   * Generate QR code for document verification
   * @param {Object} documentInfo - Document information
   * @returns {Promise<Buffer>} - QR code buffer
   */
  static async generateDocumentQR(documentInfo) {
    try {
      const {
        documentHash,
        studentId,
        documentType,
        institutionName,
        verificationUrl = process.env.FRONTEND_URL || 'http://localhost:3001'
      } = documentInfo;

      const qrData = {
        documentHash,
        studentId,
        documentType,
        institutionName,
        verificationUrl: `${verificationUrl}/verify`,
        timestamp: new Date().toISOString(),
        version: '1.0'
      };

      return await this.generateQR(JSON.stringify(qrData), {
        width: 200,
        errorCorrectionLevel: 'H' // High error correction for document verification
      });
    } catch (error) {
      console.error('Error generating document QR code:', error);
      throw new Error('Failed to generate document QR code');
    }
  }

  /**
   * Generate QR code as data URL (base64)
   * @param {string} data - Data to encode
   * @param {Object} options - QR code options
   * @returns {Promise<string>} - Base64 data URL
   */
  static async generateQRDataURL(data, options = {}) {
    try {
      const defaultOptions = {
        type: 'png',
        quality: 0.92,
        margin: 1,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        width: 256,
        errorCorrectionLevel: 'M'
      };

      const qrOptions = { ...defaultOptions, ...options };
      const dataURL = await QRCode.toDataURL(data, qrOptions);
      return dataURL;
    } catch (error) {
      console.error('Error generating QR code data URL:', error);
      throw new Error('Failed to generate QR code data URL');
    }
  }

  /**
   * Generate QR code and save to file
   * @param {string} data - Data to encode
   * @param {string} filename - Output filename
   * @param {string} directory - Output directory
   * @param {Object} options - QR code options
   * @returns {Promise<string>} - File path
   */
  static async generateQRFile(data, filename, directory = 'uploads/qr', options = {}) {
    try {
      const dirPath = path.join(__dirname, '..', directory);
      const filePath = path.join(dirPath, filename);

      // Ensure directory exists
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      const defaultOptions = {
        type: 'png',
        quality: 0.92,
        margin: 1,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        width: 256,
        errorCorrectionLevel: 'M'
      };

      const qrOptions = { ...defaultOptions, ...options };
      await QRCode.toFile(filePath, data, qrOptions);
      
      return filePath;
    } catch (error) {
      console.error('Error saving QR code file:', error);
      throw new Error('Failed to save QR code file');
    }
  }

  /**
   * Generate verification URL QR code
   * @param {string} documentHash - Document hash for verification
   * @param {Object} additionalData - Additional data to include
   * @returns {Promise<Buffer>} - QR code buffer
   */
  static async generateVerificationQR(documentHash, additionalData = {}) {
    try {
      const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
      const verificationUrl = `${baseUrl}/verify?hash=${documentHash}`;

      const qrData = {
        url: verificationUrl,
        documentHash,
        action: 'verify',
        timestamp: new Date().toISOString(),
        ...additionalData
      };

      return await this.generateQR(JSON.stringify(qrData), {
        width: 200,
        errorCorrectionLevel: 'H'
      });
    } catch (error) {
      console.error('Error generating verification QR code:', error);
      throw new Error('Failed to generate verification QR code');
    }
  }

  /**
   * Parse QR code data
   * @param {string} qrString - QR code string data
   * @returns {Object} - Parsed QR data
   */
  static parseQRData(qrString) {
    try {
      // Try to parse as JSON first
      const parsed = JSON.parse(qrString);
      
      // Validate required fields for document verification
      if (parsed.documentHash) {
        return {
          valid: true,
          type: 'document_verification',
          data: parsed
        };
      }
      
      // Check if it's a simple URL
      if (parsed.url || qrString.startsWith('http')) {
        return {
          valid: true,
          type: 'url',
          data: { url: parsed.url || qrString }
        };
      }
      
      return {
        valid: true,
        type: 'raw',
        data: { raw: qrString }
      };
      
    } catch (error) {
      // If JSON parsing fails, treat as raw string
      if (qrString.startsWith('http')) {
        return {
          valid: true,
          type: 'url',
          data: { url: qrString }
        };
      }
      
      return {
        valid: false,
        error: 'Invalid QR code format',
        data: { raw: qrString }
      };
    }
  }

  /**
   * Validate document QR code data
   * @param {Object} qrData - Parsed QR code data
   * @returns {Object} - Validation result
   */
  static validateDocumentQR(qrData) {
    const required = ['documentHash', 'studentId', 'documentType'];
    const missing = [];
    
    required.forEach(field => {
      if (!qrData[field]) {
        missing.push(field);
      }
    });
    
    if (missing.length > 0) {
      return {
        valid: false,
        error: `Missing required fields: ${missing.join(', ')}`,
        missing
      };
    }
    
    // Validate document hash format
    if (!/^0x[a-fA-F0-9]{64}$/.test(qrData.documentHash)) {
      return {
        valid: false,
        error: 'Invalid document hash format'
      };
    }
    
    return {
      valid: true,
      message: 'Valid document QR code'
    };
  }

  /**
   * Generate batch QR codes
   * @param {Array} dataArray - Array of data to encode
   * @param {Object} options - QR code options
   * @returns {Promise<Array>} - Array of QR code buffers
   */
  static async generateBatchQR(dataArray, options = {}) {
    try {
      const qrPromises = dataArray.map(data => 
        this.generateQR(typeof data === 'string' ? data : JSON.stringify(data), options)
      );
      
      return await Promise.all(qrPromises);
    } catch (error) {
      console.error('Error generating batch QR codes:', error);
      throw new Error('Failed to generate batch QR codes');
    }
  }

  /**
   * Generate QR code with custom styling
   * @param {string} data - Data to encode
   * @param {Object} styling - Custom styling options
   * @returns {Promise<Buffer>} - Styled QR code buffer
   */
  static async generateStyledQR(data, styling = {}) {
    try {
      const {
        darkColor = '#000000',
        lightColor = '#FFFFFF',
        width = 256,
        margin = 1,
        errorCorrection = 'M',
        logo = null // Future enhancement for logo embedding
      } = styling;

      const options = {
        type: 'png',
        quality: 0.92,
        margin,
        color: {
          dark: darkColor,
          light: lightColor
        },
        width,
        errorCorrectionLevel: errorCorrection
      };

      return await this.generateQR(data, options);
    } catch (error) {
      console.error('Error generating styled QR code:', error);
      throw new Error('Failed to generate styled QR code');
    }
  }

  /**
   * Get QR code info without generating
   * @param {string} data - Data that would be encoded
   * @returns {Object} - QR code information
   */
  static getQRInfo(data) {
    try {
      const dataLength = data.length;
      let version = 1;
      let capacity = 25; // Version 1 alphanumeric capacity

      // Estimate QR version based on data length (simplified)
      if (dataLength > 25) version = 2;
      if (dataLength > 47) version = 3;
      if (dataLength > 77) version = 4;
      if (dataLength > 114) version = 5;
      
      return {
        dataLength,
        estimatedVersion: version,
        estimatedSize: `${21 + (version - 1) * 4}x${21 + (version - 1) * 4}`,
        dataType: this.detectDataType(data),
        complexity: dataLength < 100 ? 'low' : dataLength < 300 ? 'medium' : 'high'
      };
    } catch (error) {
      return {
        error: 'Failed to analyze QR code info'
      };
    }
  }

  /**
   * Detect data type for QR optimization
   * @param {string} data - Data to analyze
   * @returns {string} - Detected data type
   */
  static detectDataType(data) {
    if (data.startsWith('http://') || data.startsWith('https://')) {
      return 'url';
    }
    
    if (data.startsWith('mailto:')) {
      return 'email';
    }
    
    if (data.startsWith('tel:')) {
      return 'phone';
    }
    
    try {
      JSON.parse(data);
      return 'json';
    } catch {
      return 'text';
    }
  }
}

module.exports = QRService;