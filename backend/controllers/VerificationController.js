const PDFService = require('../services/PDFService');

class VerificationController {

  /**
   * Verify document using hash directly
   */
  static async verifyDocumentHash(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      
      if (!blockchain || !blockchain.initialized) {
        return res.status(503).json({
          error: 'Blockchain service not available'
        });
      }

      const { documentHash } = req.body;

      if (!documentHash) {
        return res.status(400).json({
          error: 'Document hash is required'
        });
      }

      const verification = await blockchain.verifyDocument(documentHash);

      if (verification.success && verification.verified) {
        res.json({
          success: true,
          verified: true,
          message: 'Document is authentic and verified',
          document: verification.document,
          verificationTimestamp: new Date().toISOString()
        });
      } else if (verification.success && !verification.verified) {
        res.json({
          success: true,
          verified: false,
          message: 'Document not found or has been tampered with',
          verificationTimestamp: new Date().toISOString()
        });
      } else {
        res.status(500).json({
          error: 'Verification failed',
          message: verification.error
        });
      }

    } catch (error) {
      console.error('Error in verifyDocumentHash:', error);
      res.status(500).json({
        error: 'Failed to verify document hash',
        message: error.message
      });
    }
  }

  /**
   * Verify document by uploading file (supports both PDF and Word documents)
   */
  static async verifyDocumentFromFile(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      
      if (!blockchain || !blockchain.initialized) {
        return res.status(503).json({
          error: 'Blockchain service not available'
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: 'Document file is required'
        });
      }

      let extractedContent;
      let fileType = 'Unknown';

      try {
        // Determine file type and extract content accordingly
        if (req.file.mimetype === 'application/pdf') {
          fileType = 'PDF';
          extractedContent = await PDFService.extractTextFromPDF(req.file.buffer);
        } else if (
          req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
          req.file.mimetype === 'application/msword'
        ) {
          fileType = 'Word Document';
          extractedContent = await PDFService.extractStandardizedContentFromWord(req.file.buffer);
        } else {
          return res.status(400).json({
            error: 'Unsupported file type',
            message: 'Only PDF and Word documents are supported'
          });
        }

        if (!extractedContent || extractedContent.trim() === '') {
          return res.status(400).json({
            error: 'Unable to extract content from document',
            message: 'Document appears to be empty or corrupted'
          });
        }

      } catch (extractError) {
        console.error('Content extraction error:', extractError);
        return res.status(400).json({
          error: 'Failed to process document',
          message: 'Unable to extract content from the uploaded file'
        });
      }

      // Generate hash from extracted content using same method as registration
      const calculatedHash = PDFService.generateDocumentHash(extractedContent);

      // Verify the calculated hash against blockchain
      const verification = await blockchain.verifyDocument(calculatedHash);

      if (verification.success && verification.verified) {
        res.json({
          success: true,
          verified: true,
          message: `${fileType} document is authentic and verified`,
          document: verification.document,
          verificationTimestamp: new Date().toISOString(),
          fileDetails: {
            originalName: req.file.originalname,
            size: req.file.size,
            type: req.file.mimetype,
            fileType: fileType
          },
          calculatedHash: calculatedHash
        });
      } else if (verification.success && !verification.verified) {
        res.json({
          success: true,
          verified: false,
          message: `${fileType} document not found in blockchain or has been tampered with`,
          verificationTimestamp: new Date().toISOString(),
          fileDetails: {
            originalName: req.file.originalname,
            size: req.file.size,
            type: req.file.mimetype,
            fileType: fileType
          },
          calculatedHash: calculatedHash
        });
      } else {
        res.status(500).json({
          error: 'Verification failed',
          message: verification.error
        });
      }

    } catch (error) {
      console.error('Error in verifyDocumentFromFile:', error);
      res.status(500).json({
        error: 'Failed to verify document file',
        message: error.message
      });
    }
  }

  /**
   * Verify document by uploading PDF file (legacy method for backward compatibility)
   */
  static async verifyDocumentFromPDF(req, res) {
    // Redirect to the new unified file verification method
    await VerificationController.verifyDocumentFromFile(req, res);
  }

  /**
   * Verify document using QR code data
   */
  static async verifyDocumentFromQR(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      
      if (!blockchain || !blockchain.initialized) {
        return res.status(503).json({
          error: 'Blockchain service not available'
        });
      }

      const { qrData } = req.body;

      if (!qrData) {
        return res.status(400).json({
          error: 'QR code data is required'
        });
      }

      let parsedData;
      try {
        parsedData = typeof qrData === 'string' ? JSON.parse(qrData) : qrData;
      } catch (error) {
        return res.status(400).json({
          error: 'Invalid QR code data format'
        });
      }

      // Check if it's a preview QR code
      if (parsedData.preview) {
        return res.json({
          success: true,
          verified: false,
          message: 'This is a preview document - not registered on blockchain',
          isPreview: true
        });
      }

      const { documentHash } = parsedData;
      
      if (!documentHash) {
        return res.status(400).json({
          error: 'Document hash not found in QR code data'
        });
      }

      const verification = await blockchain.verifyDocument(documentHash);

      if (verification.success && verification.verified) {
        res.json({
          success: true,
          verified: true,
          message: 'QR code document is authentic and verified',
          document: verification.document,
          qrData: parsedData,
          verificationTimestamp: new Date().toISOString()
        });
      } else if (verification.success && !verification.verified) {
        res.json({
          success: true,
          verified: false,
          message: 'QR code document not found or has been tampered with',
          qrData: parsedData,
          verificationTimestamp: new Date().toISOString()
        });
      } else {
        res.status(500).json({
          error: 'Verification failed',
          message: verification.error
        });
      }

    } catch (error) {
      console.error('Error in verifyDocumentFromQR:', error);
      res.status(500).json({
        error: 'Failed to verify QR code',
        message: error.message
      });
    }
  }

  /**
   * Get detailed document information for verification display
   */
  static async getDocumentDetails(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      
      if (!blockchain || !blockchain.initialized) {
        return res.status(503).json({
          error: 'Blockchain service not available'
        });
      }

      const { documentHash } = req.params;

      const verification = await blockchain.verifyDocument(documentHash);

      if (verification.success && verification.verified) {
        // Get additional blockchain info
        const stats = await blockchain.getContractStats();
        
        res.json({
          success: true,
          verified: true,
          document: verification.document,
          blockchainInfo: {
            contractStats: stats,
            verificationTimestamp: new Date().toISOString()
          }
        });
      } else {
        res.status(404).json({
          error: 'Document not found',
          documentHash
        });
      }

    } catch (error) {
      console.error('Error in getDocumentDetails:', error);
      res.status(500).json({
        error: 'Failed to get document details',
        message: error.message
      });
    }
  }

  /**
   * Get verification statistics
   */
  static async getVerificationStats(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      
      if (!blockchain || !blockchain.initialized) {
        return res.status(503).json({
          error: 'Blockchain service not available'
        });
      }

      const stats = await blockchain.getContractStats();

      res.json({
        success: true,
        statistics: {
          totalDocuments: parseInt(stats.totalDocuments),
          totalRegistrars: parseInt(stats.totalRegistrars),
          contractOwner: stats.contractOwner,
          lastUpdated: new Date().toISOString()
        }
      });

    } catch (error) {
      console.error('Error in getVerificationStats:', error);
      res.status(500).json({
        error: 'Failed to get verification statistics',
        message: error.message
      });
    }
  }

  /**
   * Verify multiple documents at once (supports mixed PDF and Word documents)
   */
  static async bulkVerifyDocuments(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      
      if (!blockchain || !blockchain.initialized) {
        return res.status(503).json({
          error: 'Blockchain service not available'
        });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          error: 'At least one document file is required'
        });
      }

      const results = [];

      for (const file of req.files) {
        try {
          let extractedContent;
          let fileType = 'Unknown';

          // Determine file type and extract content
          if (file.mimetype === 'application/pdf') {
            fileType = 'PDF';
            extractedContent = await PDFService.extractTextFromPDF(file.buffer);
          } else if (
            file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            file.mimetype === 'application/msword'
          ) {
            fileType = 'Word Document';
            extractedContent = await PDFService.extractStandardizedContentFromWord(file.buffer);
          } else {
            results.push({
              filename: file.originalname,
              size: file.size,
              fileType: fileType,
              verified: false,
              document: null,
              error: `Unsupported file type: ${file.mimetype}`
            });
            continue;
          }
          
          if (extractedContent && extractedContent.trim() !== '') {
            // Generate hash and verify
            const calculatedHash = PDFService.generateDocumentHash(extractedContent);
            const verification = await blockchain.verifyDocument(calculatedHash);
            
            results.push({
              filename: file.originalname,
              size: file.size,
              fileType: fileType,
              verified: verification.success && verification.verified,
              document: verification.verified ? verification.document : null,
              calculatedHash: calculatedHash,
              error: verification.error || null
            });
          } else {
            results.push({
              filename: file.originalname,
              size: file.size,
              fileType: fileType,
              verified: false,
              document: null,
              error: 'Unable to extract content from document'
            });
          }
        } catch (fileError) {
          results.push({
            filename: file.originalname,
            size: file.size,
            fileType: 'Unknown',
            verified: false,
            document: null,
            error: fileError.message
          });
        }
      }

      const verifiedCount = results.filter(r => r.verified).length;
      const failedCount = results.length - verifiedCount;

      res.json({
        success: true,
        message: `Bulk verification completed: ${verifiedCount} verified, ${failedCount} failed`,
        summary: {
          totalFiles: results.length,
          verified: verifiedCount,
          failed: failedCount
        },
        results,
        verificationTimestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Error in bulkVerifyDocuments:', error);
      res.status(500).json({
        error: 'Failed to bulk verify documents',
        message: error.message
      });
    }
  }

  /**
   * Compare two documents to check if they match
   */
  static async compareDocuments(req, res) {
    try {
      if (!req.files || req.files.length !== 2) {
        return res.status(400).json({
          error: 'Exactly two document files are required for comparison'
        });
      }

      const [file1, file2] = req.files;
      let content1, content2;

      try {
        // Extract content from first document
        content1 = await PDFService.extractContentForVerification(file1.buffer, file1.mimetype);
        
        // Extract content from second document
        content2 = await PDFService.extractContentForVerification(file2.buffer, file2.mimetype);
      } catch (extractError) {
        return res.status(400).json({
          error: 'Failed to extract content from one or both documents',
          message: extractError.message
        });
      }

      // Generate hashes for both documents
      const hash1 = PDFService.generateDocumentHash(content1);
      const hash2 = PDFService.generateDocumentHash(content2);

      // Check if hashes match
      const documentsMatch = hash1.toLowerCase() === hash2.toLowerCase();

      res.json({
        success: true,
        documentsMatch,
        message: documentsMatch ? 'Documents are identical' : 'Documents are different',
        comparison: {
          document1: {
            filename: file1.originalname,
            type: file1.mimetype,
            hash: hash1
          },
          document2: {
            filename: file2.originalname,
            type: file2.mimetype,
            hash: hash2
          }
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Error in compareDocuments:', error);
      res.status(500).json({
        error: 'Failed to compare documents',
        message: error.message
      });
    }
  }
}

module.exports = VerificationController;