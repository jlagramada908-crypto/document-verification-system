const PDFDocument = require('pdfkit');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers'); // Added for consistent hashing
const mammoth = require('mammoth'); // For Word document text extraction

class PDFService {

  /**
   * Generate standardized document content for hashing (compatible with Word templates)
   * This ensures consistent hashing between Word documents and PDFs
   * @param {Object} documentData - Document information
   * @returns {string} - Standardized content string for blockchain hashing
   */
  static generateDocumentContent(documentData) {
    const {
      studentId,
      studentName,
      documentType,
      courseData = [],
      grades = {},
      dateIssued,
      institutionName
    } = documentData;

    // Create standardized content format - SAME FORMAT as TemplateService
    let content = `DOCUMENT_TYPE:${documentType}\n`;
    content += `STUDENT_ID:${studentId}\n`;
    content += `STUDENT_NAME:${studentName}\n`;
    content += `INSTITUTION:${institutionName}\n`;
    content += `DATE_ISSUED:${dateIssued instanceof Date ? dateIssued.toISOString() : new Date(dateIssued).toISOString()}\n`;

    // Add course data if present
    if (courseData.length > 0) {
      content += `COURSES:\n`;
      courseData.forEach((course, index) => {
        content += `${index + 1}. ${course.courseCode} - ${course.courseName}`;
        if (course.units) content += ` (${course.units} units)`;
        if (course.grade) content += ` - Grade: ${course.grade}`;
        content += `\n`;
      });
    }

    // Add grades if present
    if (Object.keys(grades).length > 0) {
      content += `GRADES:\n`;
      Object.entries(grades).forEach(([subject, grade]) => {
        content += `${subject}: ${grade}\n`;
      });
    }

    return content;
  }

  /**
   * Generate content hash using Keccak-256 (consistent with blockchain)
   * @param {string} content - Content to hash
   * @returns {string} - Keccak-256 hash
   */
  static generateDocumentHash(content) {
    return ethers.keccak256(ethers.toUtf8Bytes(content));
  }

  /**
   * Extract standardized content from Word document for verification
   * @param {Buffer} wordBuffer - Word document buffer
   * @returns {Promise<string>} - Standardized content for hashing
   */
  static async extractStandardizedContentFromWord(wordBuffer) {
    try {
      // Extract raw text from Word document
      const result = await mammoth.extractRawText({ buffer: wordBuffer });
      let rawText = result.value;

      // Try to parse structured content if it follows our standard format
      if (rawText.includes('DOCUMENT_TYPE:') && rawText.includes('STUDENT_ID:')) {
        // Already in standardized format
        return rawText;
      }

      // If not standardized, try to extract key information and standardize
      // This is a fallback for documents that don't follow the standard format
      return rawText; // Return raw text for now - may need enhancement
      
    } catch (error) {
      console.error('Error extracting content from Word document:', error);
      throw new Error('Failed to extract content from Word document');
    }
  }

  /**
   * Generate PDF document with QR code (legacy support for non-template documents)
   * @param {Object} documentData - Document information
   * @param {Buffer} qrCodeBuffer - QR code image buffer
   * @returns {Promise<Buffer>} - PDF buffer
   */
  static async generatePDF(documentData, qrCodeBuffer) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const buffers = [];

        // Collect PDF data
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
          const pdfBuffer = Buffer.concat(buffers);
          resolve(pdfBuffer);
        });

        const {
          studentId,
          studentName,
          documentType,
          courseData = [],
          grades = {},
          dateIssued,
          institutionName
        } = documentData;

        // Header
        doc.fontSize(20).text(institutionName, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(16).text(`${documentType} - ${this.getDocumentFullName(documentType)}`, { align: 'center' });
        doc.moveDown(1);

        // Document details
        doc.fontSize(12);
        doc.text(`Student ID: ${studentId}`, 50, doc.y);
        doc.text(`Student Name: ${studentName}`, 50, doc.y + 5);
        doc.text(`Date Issued: ${dateIssued instanceof Date ? dateIssued.toLocaleDateString() : new Date(dateIssued).toLocaleDateString()}`, 50, doc.y + 5);
        doc.moveDown(1);

        // Course data section
        if (courseData.length > 0) {
          doc.fontSize(14).text('Courses:', { underline: true });
          doc.moveDown(0.5);
          doc.fontSize(11);

          courseData.forEach((course, index) => {
            let courseText = `${index + 1}. ${course.courseCode} - ${course.courseName}`;
            if (course.units) courseText += ` (${course.units} units)`;
            if (course.grade) courseText += ` - Grade: ${course.grade}`;
            doc.text(courseText, 70);
          });
          doc.moveDown(1);
        }

        // Grades section
        if (Object.keys(grades).length > 0) {
          doc.fontSize(14).text('Grades:', { underline: true });
          doc.moveDown(0.5);
          doc.fontSize(11);

          Object.entries(grades).forEach(([subject, grade]) => {
            doc.text(`${subject}: ${grade}`, 70);
          });
          doc.moveDown(1);
        }

        // Add QR code
        if (qrCodeBuffer) {
          doc.moveDown(2);
          doc.fontSize(10).text('Verification QR Code:', { align: 'center' });
          doc.image(qrCodeBuffer, doc.page.width - 150, doc.y + 10, { width: 100, height: 100 });
          doc.moveDown(8);
        }

        // Footer
        doc.fontSize(8)
           .text('This document is digitally verified on the blockchain', { align: 'center' })
           .text('Scan the QR code or visit the verification portal to authenticate', { align: 'center' });

        // Add standardized content as invisible text for hash verification
        const standardizedContent = this.generateDocumentContent(documentData);
        doc.fontSize(1).fillColor('white').text(standardizedContent, 0, 0);

        doc.end();

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Extract text content from PDF buffer for verification
   * @param {Buffer} pdfBuffer - PDF file buffer
   * @returns {Promise<string>} - Extracted text content
   */
  static async extractTextFromPDF(pdfBuffer) {
    try {
      const data = await pdf(pdfBuffer);
      return data.text;
    } catch (error) {
      console.error('Error extracting text from PDF:', error);
      throw new Error('Failed to extract text from PDF');
    }
  }

  /**
   * Extract content for verification from any document type
   * @param {Buffer} documentBuffer - Document buffer
   * @param {string} mimeType - Document MIME type
   * @returns {Promise<string>} - Extracted content for hashing
   */
  static async extractContentForVerification(documentBuffer, mimeType) {
    try {
      if (mimeType === 'application/pdf') {
        return await this.extractTextFromPDF(documentBuffer);
      } else if (
        mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        mimeType === 'application/msword'
      ) {
        return await this.extractStandardizedContentFromWord(documentBuffer);
      } else {
        throw new Error(`Unsupported document type: ${mimeType}`);
      }
    } catch (error) {
      console.error('Error extracting content for verification:', error);
      throw error;
    }
  }

  /**
   * Verify document content by comparing hashes
   * @param {string} extractedContent - Content extracted from uploaded document
   * @param {string} expectedHash - Expected hash from blockchain
   * @returns {boolean} - True if hashes match
   */
  static verifyDocumentContent(extractedContent, expectedHash) {
    try {
      const calculatedHash = this.generateDocumentHash(extractedContent);
      return calculatedHash.toLowerCase() === expectedHash.toLowerCase();
    } catch (error) {
      console.error('Error verifying document content:', error);
      return false;
    }
  }

  /**
   * Generate PDF from Word document content (for legacy compatibility)
   * @param {string} textContent - Text extracted from Word document
   * @param {Object} documentMetadata - Document metadata
   * @param {Buffer} qrCodeBuffer - QR code buffer
   * @returns {Promise<Buffer>} - Generated PDF buffer
   */
  static async generatePDFFromWordContent(textContent, documentMetadata, qrCodeBuffer) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const buffers = [];

        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));

        // Add header
        doc.fontSize(16).text(documentMetadata.institutionName || 'Institution', { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text(documentMetadata.documentType || 'Document', { align: 'center' });
        doc.moveDown(1);

        // Add main content
        doc.fontSize(12).text(textContent, { align: 'justify' });

        // Add QR code if provided
        if (qrCodeBuffer) {
          doc.moveDown(2);
          doc.fontSize(10).text('Verification QR Code:', { align: 'center' });
          doc.image(qrCodeBuffer, doc.page.width - 150, doc.y + 10, { width: 100, height: 100 });
        }

        // Add footer
        doc.fontSize(8).text('This document is digitally verified on the blockchain', { align: 'center' });

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Get full document name
   */
  static getDocumentFullName(documentType) {
    const names = {
      'COR': 'Certificate of Registration',
      'COG': 'Certificate of Grades',
      'TOR': 'Transcript of Records',
      'DIPLOMA': 'Diploma',
      'CERTIFICATE': 'Certificate'
    };
    return names[documentType] || documentType;
  }

  /**
   * Save PDF to file system
   */
  static async savePDF(pdfBuffer, filename, directory = 'uploads') {
    try {
      const dirPath = path.join(__dirname, '..', directory);
      const filePath = path.join(dirPath, filename);
      
      // Ensure directory exists
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      
      fs.writeFileSync(filePath, pdfBuffer);
      return filePath;
    } catch (error) {
      console.error('Error saving PDF:', error);
      throw new Error('Failed to save PDF file');
    }
  }

  /**
   * Create standardized content from Word template data (for consistency)
   * @param {Object} templateData - Data used to fill Word template
   * @returns {string} - Standardized content string
   */
  static createStandardizedContentFromTemplateData(templateData) {
    const {
      student_name,
      student_id,
      documentType,
      institution,
      courses = [],
      issue_date
    } = templateData;

    let content = `DOCUMENT_TYPE:${documentType || 'WORD_TEMPLATE'}\n`;
    content += `STUDENT_ID:${student_id || ''}\n`;
    content += `STUDENT_NAME:${student_name || ''}\n`;
    content += `INSTITUTION:${institution || ''}\n`;
    content += `DATE_ISSUED:${issue_date || new Date().toISOString()}\n`;

    if (courses && courses.length > 0) {
      content += `COURSES:\n`;
      courses.forEach((course, index) => {
        content += `${index + 1}. ${course.code || ''} - ${course.name || ''}`;
        if (course.units) content += ` (${course.units} units)`;
        if (course.grade) content += ` - Grade: ${course.grade}`;
        content += `\n`;
      });
    }

    return content;
  }
}

module.exports = PDFService;