const PDFService = require('../services/PDFService');
const QRService = require('../services/QRService');
const path = require('path');
const fs = require('fs').promises;

class DocumentController {
  
  /**
   * Register a new document on blockchain and generate PDF
   */
  static async registerDocument(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      
      // Check if blockchain service is available
      if (!blockchain || !blockchain.initialized) {
        return res.status(503).json({
          error: 'Blockchain service not available',
          message: 'Please ensure blockchain service is initialized'
        });
      }

      const { studentId, studentName, documentType, courseData, grades } = req.body;
      
      // Generate document content using standardized format
      const documentData = {
        studentId,
        studentName,
        documentType,
        courseData,
        grades,
        dateIssued: new Date(),
        institutionName: req.registrar.institutionName
      };

      // Generate standardized content for blockchain hashing
      const documentContent = PDFService.generateDocumentContent(documentData);
      
      // Register on blockchain using the standardized content
      const blockchainResult = await blockchain.registerDocument({
        documentContent: documentContent, // This will be hashed with Keccak-256
        studentId,
        studentName,
        documentType,
        dateIssued: Date.now()
      });

      if (!blockchainResult.success) {
        return res.status(500).json({
          error: 'Failed to register document on blockchain',
          details: blockchainResult.error
        });
      }

      // Generate QR code with verification URL
      const qrData = {
        documentHash: blockchainResult.documentHash,
        verificationUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify`,
        studentId,
        documentType
      };
      
      const qrCodeBuffer = await QRService.generateQR(JSON.stringify(qrData));

      // Generate PDF with QR code (legacy support)
      const pdfBuffer = await PDFService.generatePDF(documentData, qrCodeBuffer);
      
      // Save PDF file
      const filename = `${documentType}_${studentId}_${Date.now()}.pdf`;
      const filepath = path.join(__dirname, '../uploads', filename);
      await fs.writeFile(filepath, pdfBuffer);

      res.json({
        success: true,
        message: 'Document registered successfully',
        data: {
          documentHash: blockchainResult.documentHash,
          transactionHash: blockchainResult.transactionHash,
          blockNumber: blockchainResult.blockNumber,
          filename: filename,
          downloadUrl: `/api/documents/download/${filename}`,
          qrData: qrData,
          contentHash: PDFService.generateDocumentHash(documentContent) // For verification
        }
      });

    } catch (error) {
      console.error('Error in registerDocument:', error);
      res.status(500).json({
        error: 'Failed to register document',
        message: error.message
      });
    }
  }

  /**
   * Register multiple documents in batch
   */
  static async batchRegisterDocuments(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      
      if (!blockchain || !blockchain.initialized) {
        return res.status(503).json({
          error: 'Blockchain service not available'
        });
      }

      const { documents } = req.body;

      if (!Array.isArray(documents) || documents.length === 0) {
        return res.status(400).json({
          error: 'Documents array is required and cannot be empty'
        });
      }

      if (documents.length > 50) {
        return res.status(400).json({
          error: 'Maximum 50 documents can be processed in one batch'
        });
      }

      const results = [];
      const hashes = [];
      const studentIds = [];
      const studentNames = [];
      const documentTypes = [];
      const datesIssued = [];

      // Process each document
      for (const doc of documents) {
        const { studentId, studentName, documentType, courseData, grades } = doc;
        
        const documentData = {
          studentId,
          studentName,
          documentType,
          courseData,
          grades,
          dateIssued: new Date(),
          institutionName: req.registrar.institutionName
        };

        // Generate standardized content and hash it
        const documentContent = PDFService.generateDocumentContent(documentData);
        const documentHash = PDFService.generateDocumentHash(documentContent);

        hashes.push(documentHash);
        studentIds.push(studentId);
        studentNames.push(studentName);
        documentTypes.push(documentType);
        datesIssued.push(Math.floor(Date.now() / 1000));

        results.push({
          studentId,
          documentHash,
          documentType
        });
      }

      // Register all documents on blockchain in one transaction
      const blockchainResult = await blockchain.contract.batchRegisterDocuments(
        hashes,
        studentIds,
        studentNames,
        documentTypes,
        datesIssued
      );

      const receipt = await blockchainResult.wait();

      res.json({
        success: true,
        message: `${documents.length} documents registered successfully`,
        data: {
          transactionHash: blockchainResult.hash,
          blockNumber: receipt.blockNumber,
          documentsRegistered: results.length,
          documents: results
        }
      });

    } catch (error) {
      console.error('Error in batchRegisterDocuments:', error);
      res.status(500).json({
        error: 'Failed to batch register documents',
        message: error.message
      });
    }
  }

  /**
   * Get all documents for a student
   */
  static async getStudentDocuments(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      
      if (!blockchain || !blockchain.initialized) {
        return res.status(503).json({
          error: 'Blockchain service not available'
        });
      }

      const { studentId } = req.params;

      const documentHashes = await blockchain.getStudentDocuments(studentId);
      
      const documents = [];
      for (const hash of documentHashes) {
        const verification = await blockchain.verifyDocument(hash);
        if (verification.verified) {
          documents.push({
            hash,
            ...verification.document
          });
        }
      }

      res.json({
        success: true,
        studentId,
        totalDocuments: documents.length,
        documents
      });

    } catch (error) {
      console.error('Error in getStudentDocuments:', error);
      res.status(500).json({
        error: 'Failed to get student documents',
        message: error.message
      });
    }
  }

  /**
   * Get all documents issued by a registrar
   */
  static async getRegistrarDocuments(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      
      if (!blockchain || !blockchain.initialized) {
        return res.status(503).json({
          error: 'Blockchain service not available'
        });
      }

      const { registrarAddress } = req.params;

      const documentHashes = await blockchain.contract.getRegistrarDocuments(registrarAddress);
      
      const documents = [];
      for (const hash of documentHashes) {
        const verification = await blockchain.verifyDocument(hash);
        if (verification.verified) {
          documents.push({
            hash,
            ...verification.document
          });
        }
      }

      res.json({
        success: true,
        registrarAddress,
        totalDocuments: documents.length,
        documents
      });

    } catch (error) {
      console.error('Error in getRegistrarDocuments:', error);
      res.status(500).json({
        error: 'Failed to get registrar documents',
        message: error.message
      });
    }
  }

  /**
   * Generate PDF without blockchain registration (preview)
   */
  static async previewDocument(req, res) {
    try {
      const { studentId, studentName, documentType, courseData, grades } = req.body;
      
      const documentData = {
        studentId,
        studentName,
        documentType,
        courseData,
        grades,
        dateIssued: new Date(),
        institutionName: req.registrar.institutionName
      };

      // Generate preview QR (without real hash)
      const qrData = {
        preview: true,
        studentId,
        documentType,
        message: 'This is a preview - document not yet registered'
      };
      
      const qrCodeBuffer = await QRService.generateQR(JSON.stringify(qrData));
      const pdfBuffer = await PDFService.generatePDF(documentData, qrCodeBuffer);
      
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="preview_${documentType}_${studentId}.pdf"`,
        'Content-Length': pdfBuffer.length
      });

      res.send(pdfBuffer);

    } catch (error) {
      console.error('Error in previewDocument:', error);
      res.status(500).json({
        error: 'Failed to generate document preview',
        message: error.message
      });
    }
  }

  /**
   * Generate and register PDF document
   */
  static async generateDocumentPDF(req, res) {
    try {
      // This combines registration and PDF generation
      await DocumentController.registerDocument(req, res);
    } catch (error) {
      console.error('Error in generateDocumentPDF:', error);
      res.status(500).json({
        error: 'Failed to generate document PDF',
        message: error.message
      });
    }
  }

  /**
   * Download a generated PDF document
   */
  static async downloadDocument(req, res) {
    try {
      const { filename } = req.params;
      
      // Validate filename to prevent directory traversal
      if (!/^[a-zA-Z0-9_-]+\.(pdf|docx)$/.test(filename)) {
        return res.status(400).json({
          error: 'Invalid filename'
        });
      }

      const filepath = path.join(__dirname, '../uploads', filename);
      
      try {
        await fs.access(filepath);
      } catch (error) {
        return res.status(404).json({
          error: 'Document not found'
        });
      }

      res.download(filepath, filename);

    } catch (error) {
      console.error('Error in downloadDocument:', error);
      res.status(500).json({
        error: 'Failed to download document',
        message: error.message
      });
    }
  }

  /**
   * Register Word document from Template Service (called by Template system)
   */
  static async registerWordDocument(documentContent, studentData, registrarInfo) {
    try {
      // This is called internally by the Template system
      // when a finalized Word document needs blockchain registration
      
      const blockchain = req.app.locals.blockchain;
      
      if (!blockchain || !blockchain.initialized) {
        throw new Error('Blockchain service not available');
      }

      // Use the standardized content from Word document
      const blockchainResult = await blockchain.registerDocument({
        documentContent: documentContent, // Already standardized by TemplateService
        studentId: studentData.studentId,
        studentName: studentData.studentName,
        documentType: studentData.documentType || 'WORD_DOC',
        dateIssued: Date.now()
      });

      return blockchainResult;

    } catch (error) {
      console.error('Error in registerWordDocument:', error);
      throw error;
    }
  }
}

module.exports = DocumentController;