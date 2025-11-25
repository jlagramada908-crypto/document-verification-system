const TemplateService = require('../services/TemplateService');
const path = require('path');
const fs = require('fs').promises;

class TemplateController {

  /**
   * Upload a new Word template
   */
  static async uploadTemplate(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: 'Template file is required'
        });
      }

      const { documentType, templateName, description } = req.body;

      if (!documentType || !templateName) {
        return res.status(400).json({
          error: 'Document type and template name are required'
        });
      }

      const templateService = new TemplateService();
      
      const result = await templateService.uploadTemplate(
        req.file.buffer,
        documentType.toUpperCase(),
        templateName,
        {
          description: description || '',
          uploadedBy: req.registrar.address,
          originalFilename: req.file.originalname,
          fileSize: req.file.size
        }
      );

      res.json({
        success: true,
        message: 'Template uploaded successfully',
        template: result.templateInfo
      });

    } catch (error) {
      console.error('Error uploading template:', error);
      res.status(500).json({
        error: 'Failed to upload template',
        message: error.message
      });
    }
  }

  /**
   * List available templates
   */
  static async listTemplates(req, res) {
    try {
      const { documentType } = req.query;
      const templateService = new TemplateService();
      
      const templates = await templateService.listTemplates(documentType);

      res.json({
        success: true,
        templates,
        count: templates.length
      });

    } catch (error) {
      console.error('Error listing templates:', error);
      res.status(500).json({
        error: 'Failed to list templates',
        message: error.message
      });
    }
  }

  /**
   * Get template details
   */
  static async getTemplate(req, res) {
    try {
      const { templateId } = req.params;
      const templateService = new TemplateService();
      
      const template = await templateService.getTemplateMetadata(templateId);

      if (!template) {
        return res.status(404).json({
          error: 'Template not found'
        });
      }

      res.json({
        success: true,
        template
      });

    } catch (error) {
      console.error('Error getting template:', error);
      res.status(500).json({
        error: 'Failed to get template',
        message: error.message
      });
    }
  }

  /**
   * Generate a draft document from template
   */
  static async generateDraft(req, res) {
    try {
      const { templateId } = req.params;
      const studentData = req.body;

      // Validate required student data
      if (!studentData.studentId || !studentData.studentName) {
        return res.status(400).json({
          error: 'Student ID and name are required'
        });
      }

      const templateService = new TemplateService();
      
      const result = await templateService.generateDraft(
        templateId,
        studentData,
        req.registrar.address
      );

      res.json({
        success: true,
        message: 'Draft document generated successfully',
        draft: result.draftInfo,
        downloadUrl: result.downloadUrl
      });

    } catch (error) {
      console.error('Error generating draft:', error);
      res.status(500).json({
        error: 'Failed to generate draft',
        message: error.message
      });
    }
  }

  /**
   * List drafts for current registrar
   */
  static async listDrafts(req, res) {
    try {
      const { status } = req.query;
      const templateService = new TemplateService();
      
      const drafts = await templateService.listDrafts(req.registrar.address, status);

      res.json({
        success: true,
        drafts,
        count: drafts.length
      });

    } catch (error) {
      console.error('Error listing drafts:', error);
      res.status(500).json({
        error: 'Failed to list drafts',
        message: error.message
      });
    }
  }

  /**
   * Get draft details
   */
  static async getDraft(req, res) {
    try {
      const { draftId } = req.params;
      const templateService = new TemplateService();
      
      const draft = await templateService.getDraftMetadata(draftId);

      if (!draft) {
        return res.status(404).json({
          error: 'Draft not found'
        });
      }

      // Check if registrar owns this draft
      if (draft.registrarId !== req.registrar.address) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }

      res.json({
        success: true,
        draft
      });

    } catch (error) {
      console.error('Error getting draft:', error);
      res.status(500).json({
        error: 'Failed to get draft',
        message: error.message
      });
    }
  }

  /**
   * Download draft document
   */
  static async downloadDraft(req, res) {
    try {
      const { draftId } = req.params;
      const templateService = new TemplateService();
      
      const draft = await templateService.getDraftMetadata(draftId);

      if (!draft) {
        return res.status(404).json({
          error: 'Draft not found'
        });
      }

      // Check if registrar owns this draft (or allow public access for verification)
      if (req.registrar && draft.registrarId !== req.registrar.address) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }

      // Check if file exists
      try {
        await fs.access(draft.filepath);
      } catch (error) {
        return res.status(404).json({
          error: 'Document file not found'
        });
      }

      // Set headers for file download
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${draft.filename}"`,
      });

      // Stream the file
      const fileBuffer = await fs.readFile(draft.filepath);
      res.send(fileBuffer);

    } catch (error) {
      console.error('Error downloading draft:', error);
      res.status(500).json({
        error: 'Failed to download draft',
        message: error.message
      });
    }
  }

  /**
   * Upload edited draft document
   */
  static async uploadEditedDraft(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: 'Edited document file is required'
        });
      }

      const { draftId } = req.params;
      const templateService = new TemplateService();
      
      const result = await templateService.updateDraft(draftId, req.file.buffer);

      res.json({
        success: true,
        message: 'Draft updated successfully',
        draft: result.draftInfo
      });

    } catch (error) {
      console.error('Error uploading edited draft:', error);
      res.status(500).json({
        error: 'Failed to upload edited draft',
        message: error.message
      });
    }
  }

  /**
   * Finalize draft document
   */
  static async finalizeDraft(req, res) {
    try {
      const { draftId } = req.params;
      const templateService = new TemplateService();
      
      const result = await templateService.finalizeDraft(draftId, req.registrar.address);

      res.json({
        success: true,
        message: 'Draft finalized successfully',
        finalized: result.finalizedInfo,
        contentHash: result.contentHash,
        readyForBlockchain: true
      });

    } catch (error) {
      console.error('Error finalizing draft:', error);
      res.status(500).json({
        error: 'Failed to finalize draft',
        message: error.message
      });
    }
  }

  /**
   * Register finalized document on blockchain
   */
  static async registerOnBlockchain(req, res) {
    try {
      const { finalizedId } = req.params;
      const templateService = new TemplateService();
      const blockchain = req.app.locals.blockchain;

      // Get finalized document
      const result = await templateService.getFinalizedDocument(finalizedId);
      const finalizedDoc = result.document;

      // Prepare document data for blockchain registration
      const documentData = {
        documentContent: finalizedDoc.textContent, // This will be hashed
        studentId: finalizedDoc.studentData.studentId,
        studentName: finalizedDoc.studentData.studentName,
        documentType: finalizedDoc.studentData.documentType || 'WORD_DOC',
        dateIssued: new Date(finalizedDoc.finalizedDate).getTime()
      };

      // Register on blockchain
      const blockchainResult = await blockchain.registerDocument(documentData);

      if (!blockchainResult.success) {
        return res.status(500).json({
          error: 'Failed to register document on blockchain',
          details: blockchainResult.error
        });
      }

      // Mark as blockchain registered
      await templateService.markAsBlockchainRegistered(finalizedId, {
        documentHash: blockchainResult.documentHash,
        transactionHash: blockchainResult.transactionHash,
        blockNumber: blockchainResult.blockNumber
      });

      res.json({
        success: true,
        message: 'Document registered on blockchain successfully',
        blockchain: {
          documentHash: blockchainResult.documentHash,
          transactionHash: blockchainResult.transactionHash,
          blockNumber: blockchainResult.blockNumber
        },
        document: finalizedDoc
      });

    } catch (error) {
      console.error('Error registering on blockchain:', error);
      res.status(500).json({
        error: 'Failed to register on blockchain',
        message: error.message
      });
    }
  }

  /**
   * Get finalized document details
   */
  static async getFinalizedDocument(req, res) {
    try {
      const { finalizedId } = req.params;
      const templateService = new TemplateService();
      
      const result = await templateService.getFinalizedDocument(finalizedId);

      res.json({
        success: true,
        document: result.document
      });

    } catch (error) {
      console.error('Error getting finalized document:', error);
      res.status(500).json({
        error: 'Failed to get finalized document',
        message: error.message
      });
    }
  }

  /**
   * Download finalized document
   */
  static async downloadFinalizedDocument(req, res) {
    try {
      const { finalizedId } = req.params;
      const templateService = new TemplateService();
      
      const result = await templateService.getFinalizedDocument(finalizedId);
      const finalizedDoc = result.document;

      // Check if file exists
      try {
        await fs.access(finalizedDoc.filepath);
      } catch (error) {
        return res.status(404).json({
          error: 'Document file not found'
        });
      }

      // Set headers for file download
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${finalizedDoc.filename}"`,
      });

      // Stream the file
      const fileBuffer = await fs.readFile(finalizedDoc.filepath);
      res.send(fileBuffer);

    } catch (error) {
      console.error('Error downloading finalized document:', error);
      res.status(500).json({
        error: 'Failed to download finalized document',
        message: error.message
      });
    }
  }

  /**
   * Delete draft (before finalization)
   */
  static async deleteDraft(req, res) {
    try {
      const { draftId } = req.params;
      const templateService = new TemplateService();
      
      const draft = await templateService.getDraftMetadata(draftId);

      if (!draft) {
        return res.status(404).json({
          error: 'Draft not found'
        });
      }

      // Check ownership
      if (draft.registrarId !== req.registrar.address) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }

      // Can't delete finalized drafts
      if (draft.isFinalized) {
        return res.status(400).json({
          error: 'Cannot delete finalized document'
        });
      }

      // Delete file
      try {
        await fs.unlink(draft.filepath);
      } catch (error) {
        console.log('File already deleted or not found:', error);
      }

      // Mark as deleted in metadata
      draft.deleted = true;
      draft.deletedDate = new Date().toISOString();
      await templateService.saveDraftMetadata(draft);

      res.json({
        success: true,
        message: 'Draft deleted successfully'
      });

    } catch (error) {
      console.error('Error deleting draft:', error);
      res.status(500).json({
        error: 'Failed to delete draft',
        message: error.message
      });
    }
  }

  /**
   * Preview template with sample data
   */
  static async previewTemplate(req, res) {
    try {
      const { templateId } = req.params;
      const { sampleData } = req.body;
      
      const templateService = new TemplateService();
      
      // Use provided sample data or default sample
      const defaultSampleData = {
        studentId: 'SAMPLE-001',
        studentName: 'John Doe',
        documentType: 'SAMPLE',
        program: 'Bachelor of Science in Computer Science',
        yearLevel: '4th Year',
        semester: 'First Semester',
        academicYear: '2024-2025',
        courseData: [
          {
            courseCode: 'CS101',
            courseName: 'Introduction to Computer Science',
            units: '3',
            grade: 'A'
          },
          {
            courseCode: 'MATH101',
            courseName: 'Calculus I',
            units: '4',
            grade: 'B+'
          }
        ],
        grades: {
          'Overall GPA': '3.75'
        }
      };

      const previewData = sampleData || defaultSampleData;
      
      const result = await templateService.generateDraft(
        templateId,
        previewData,
        'PREVIEW_' + req.registrar.address
      );

      res.json({
        success: true,
        message: 'Template preview generated',
        preview: result.draftInfo,
        downloadUrl: result.downloadUrl,
        isPreview: true
      });

    } catch (error) {
      console.error('Error previewing template:', error);
      res.status(500).json({
        error: 'Failed to preview template',
        message: error.message
      });
    }
  }
}

module.exports = TemplateController;