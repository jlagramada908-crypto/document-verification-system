const fs = require('fs').promises;
const path = require('path');
const Docxtemplater = require('docxtemplater');
const PizZip = require('pizzip');
const mammoth = require('mammoth');
const { ethers } = require('ethers'); // Use ethers for consistent hashing
const PDFService = require('./PDFService'); // Import for consistent content generation

class TemplateService {
  constructor() {
    this.templatesDir = path.join(__dirname, '../templates');
    this.draftsDir = path.join(__dirname, '../drafts');
    this.finalizedDir = path.join(__dirname, '../finalized');
    
    // Ensure directories exist
    this.initializeDirs();
  }

  /**
   * Initialize required directories
   */
  async initializeDirs() {
    const dirs = [this.templatesDir, this.draftsDir, this.finalizedDir];
    
    for (const dir of dirs) {
      try {
        await fs.access(dir);
      } catch (error) {
        await fs.mkdir(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
      }
    }
  }

  /**
   * Generate consistent document hash using same method as PDFService
   * @param {string} content - Content to hash
   * @returns {string} - Keccak-256 hash (consistent with blockchain)
   */
  generateDocumentHash(content) {
    return PDFService.generateDocumentHash(content);
  }

  /**
   * Create standardized content from template data (same format as PDFService)
   * @param {Object} templateData - Template data
   * @param {Object} studentData - Original student data
   * @returns {string} - Standardized content for blockchain hashing
   */
  createStandardizedContent(templateData, studentData) {
    // Use PDFService method to ensure consistency
    const documentData = {
      studentId: studentData.studentId,
      studentName: studentData.studentName,
      documentType: studentData.documentType,
      courseData: studentData.courseData || [],
      grades: studentData.grades || {},
      dateIssued: new Date(),
      institutionName: studentData.institutionName || templateData.institution || 'Institution'
    };

    return PDFService.generateDocumentContent(documentData);
  }

  /**
   * Upload and store a Word template
   */
  async uploadTemplate(templateBuffer, documentType, templateName, metadata = {}) {
    try {
      // Validate it's a valid Word document
      await this.validateWordDocument(templateBuffer);

      // Generate template ID
      const templateId = `${documentType}_${Date.now()}`;
      const filename = `${templateId}.docx`;
      const filepath = path.join(this.templatesDir, filename);

      // Save template file
      await fs.writeFile(filepath, templateBuffer);

      // Extract placeholders from template
      const placeholders = await this.extractPlaceholders(templateBuffer);

      // Save template metadata
      const templateInfo = {
        id: templateId,
        documentType,
        templateName,
        filename,
        filepath,
        placeholders,
        uploadDate: new Date().toISOString(),
        isActive: true,
        metadata
      };

      await this.saveTemplateMetadata(templateInfo);

      return {
        success: true,
        templateId,
        templateInfo,
        message: 'Template uploaded successfully'
      };

    } catch (error) {
      console.error('Error uploading template:', error);
      throw new Error(`Failed to upload template: ${error.message}`);
    }
  }

  /**
   * Generate a draft document from template
   */
  async generateDraft(templateId, studentData, registrarId) {
    try {
      const templateInfo = await this.getTemplateMetadata(templateId);
      if (!templateInfo) {
        throw new Error('Template not found');
      }

      // Load template
      const templateBuffer = await fs.readFile(templateInfo.filepath);
      const zip = new PizZip(templateBuffer);
      const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
      });

      // Prepare data for template
      const templateData = this.prepareTemplateData(studentData, templateInfo.placeholders);

      // Fill template with data
      doc.setData(templateData);
      doc.render();

      // Generate draft document
      const draftBuffer = doc.getZip().generate({ type: 'nodebuffer' });
      
      // Create draft ID and save
      const draftId = `draft_${templateId}_${studentData.studentId}_${Date.now()}`;
      const draftFilename = `${draftId}.docx`;
      const draftFilepath = path.join(this.draftsDir, draftFilename);

      await fs.writeFile(draftFilepath, draftBuffer);

      // Save draft metadata
      const draftInfo = {
        id: draftId,
        templateId,
        studentId: studentData.studentId,
        registrarId,
        filename: draftFilename,
        filepath: draftFilepath,
        studentData,
        templateData,
        createdDate: new Date().toISOString(),
        status: 'draft',
        isFinalized: false
      };

      await this.saveDraftMetadata(draftInfo);

      return {
        success: true,
        draftId,
        draftInfo,
        downloadUrl: `/api/templates/download-draft/${draftId}`,
        message: 'Draft document generated successfully'
      };

    } catch (error) {
      console.error('Error generating draft:', error);
      throw new Error(`Failed to generate draft: ${error.message}`);
    }
  }

  /**
   * Update draft document with edited content
   */
  async updateDraft(draftId, editedBuffer) {
    try {
      const draftInfo = await this.getDraftMetadata(draftId);
      if (!draftInfo) {
        throw new Error('Draft not found');
      }

      if (draftInfo.isFinalized) {
        throw new Error('Cannot edit finalized document');
      }

      // Validate edited document
      await this.validateWordDocument(editedBuffer);

      // Save edited version
      await fs.writeFile(draftInfo.filepath, editedBuffer);

      // Update metadata
      draftInfo.lastModified = new Date().toISOString();
      draftInfo.editCount = (draftInfo.editCount || 0) + 1;

      await this.saveDraftMetadata(draftInfo);

      return {
        success: true,
        message: 'Draft updated successfully',
        draftInfo
      };

    } catch (error) {
      console.error('Error updating draft:', error);
      throw new Error(`Failed to update draft: ${error.message}`);
    }
  }

  /**
   * Finalize draft document - prepare for blockchain registration
   */
  async finalizeDraft(draftId, registrarId) {
    try {
      const draftInfo = await this.getDraftMetadata(draftId);
      if (!draftInfo) {
        throw new Error('Draft not found');
      }

      if (draftInfo.isFinalized) {
        throw new Error('Document already finalized');
      }

      // Read current draft
      const draftBuffer = await fs.readFile(draftInfo.filepath);
      
      // Extract text content for hashing
      const rawTextContent = await this.extractTextContent(draftBuffer);
      
      // Generate standardized content for blockchain (CRITICAL: Use same format as PDFService)
      const standardizedContent = this.createStandardizedContent(
        draftInfo.templateData, 
        draftInfo.studentData
      );
      
      // Generate content hash using consistent method
      const contentHash = this.generateDocumentHash(standardizedContent);
      
      // Create finalized version
      const finalizedId = `final_${draftId}_${Date.now()}`;
      const finalizedFilename = `${finalizedId}.docx`;
      const finalizedFilepath = path.join(this.finalizedDir, finalizedFilename);

      // Copy to finalized directory
      await fs.writeFile(finalizedFilepath, draftBuffer);

      // Update draft info
      draftInfo.isFinalized = true;
      draftInfo.finalizedDate = new Date().toISOString();
      draftInfo.finalizedBy = registrarId;
      draftInfo.finalizedId = finalizedId;
      draftInfo.contentHash = contentHash;
      draftInfo.status = 'finalized';

      await this.saveDraftMetadata(draftInfo);

      // Save finalized document metadata
      const finalizedInfo = {
        id: finalizedId,
        draftId,
        templateId: draftInfo.templateId,
        studentId: draftInfo.studentId,
        registrarId,
        filename: finalizedFilename,
        filepath: finalizedFilepath,
        contentHash,
        standardizedContent, // For blockchain hashing - CRITICAL
        rawTextContent, // Original text from Word document
        studentData: draftInfo.studentData,
        templateData: draftInfo.templateData,
        finalizedDate: new Date().toISOString(),
        status: 'ready_for_blockchain',
        blockchainRegistered: false
      };

      await this.saveFinalizedMetadata(finalizedInfo);

      return {
        success: true,
        finalizedId,
        contentHash,
        finalizedInfo,
        message: 'Document finalized and ready for blockchain registration'
      };

    } catch (error) {
      console.error('Error finalizing draft:', error);
      throw new Error(`Failed to finalize draft: ${error.message}`);
    }
  }

  /**
   * Get finalized document for blockchain registration
   */
  async getFinalizedDocument(finalizedId) {
    try {
      const finalizedInfo = await this.getFinalizedMetadata(finalizedId);
      if (!finalizedInfo) {
        throw new Error('Finalized document not found');
      }

      return {
        success: true,
        document: finalizedInfo,
        textContent: finalizedInfo.standardizedContent, // Use standardized content for blockchain
        contentHash: finalizedInfo.contentHash
      };

    } catch (error) {
      console.error('Error getting finalized document:', error);
      throw new Error(`Failed to get finalized document: ${error.message}`);
    }
  }

  /**
   * Mark finalized document as registered on blockchain
   */
  async markAsBlockchainRegistered(finalizedId, blockchainInfo) {
    try {
      const finalizedInfo = await this.getFinalizedMetadata(finalizedId);
      if (!finalizedInfo) {
        throw new Error('Finalized document not found');
      }

      finalizedInfo.blockchainRegistered = true;
      finalizedInfo.blockchainInfo = blockchainInfo;
      finalizedInfo.registrationDate = new Date().toISOString();
      finalizedInfo.status = 'blockchain_registered';

      await this.saveFinalizedMetadata(finalizedInfo);

      return {
        success: true,
        message: 'Document marked as blockchain registered'
      };

    } catch (error) {
      console.error('Error marking as blockchain registered:', error);
      throw new Error(`Failed to mark as blockchain registered: ${error.message}`);
    }
  }

  /**
   * Extract placeholders from Word template
   */
  async extractPlaceholders(templateBuffer) {
    try {
      const zip = new PizZip(templateBuffer);
      const doc = new Docxtemplater(zip);
      
      // Get template text
      const templateText = doc.getFullText();
      
      // Extract placeholders using regex
      const placeholderRegex = /\{\{([^}]+)\}\}/g;
      const placeholders = [];
      let match;
      
      while ((match = placeholderRegex.exec(templateText)) !== null) {
        const placeholder = match[1].trim();
        if (!placeholders.includes(placeholder)) {
          placeholders.push(placeholder);
        }
      }
      
      return placeholders;
      
    } catch (error) {
      console.error('Error extracting placeholders:', error);
      return [];
    }
  }

  /**
   * Prepare data for template filling
   */
  prepareTemplateData(studentData, placeholders) {
    const templateData = {};
    
    // Map common fields
    const fieldMapping = {
      'name': studentData.studentName,
      'student_name': studentData.studentName,
      'studentName': studentData.studentName,
      'id': studentData.studentId,
      'student_id': studentData.studentId,
      'studentId': studentData.studentId,
      'document_type': studentData.documentType,
      'documentType': studentData.documentType,
      'date': new Date().toLocaleDateString(),
      'current_date': new Date().toLocaleDateString(),
      'issue_date': new Date().toLocaleDateString(),
      'institution': studentData.institutionName || 'Institution Name',
      'program': studentData.program || '',
      'year_level': studentData.yearLevel || '',
      'semester': studentData.semester || '',
      'academic_year': studentData.academicYear || ''
    };

    // Fill mapped fields
    Object.keys(fieldMapping).forEach(key => {
      if (placeholders.includes(key)) {
        templateData[key] = fieldMapping[key] || '';
      }
    });

    // Handle courses array
    if (studentData.courseData && Array.isArray(studentData.courseData)) {
      templateData.courses = studentData.courseData.map(course => ({
        code: course.courseCode || '',
        name: course.courseName || '',
        units: course.units || '',
        grade: course.grade || '',
        schedule: course.schedule || ''
      }));

      // For simple course listing
      templateData.course_list = studentData.courseData.map(course => 
        `${course.courseCode} - ${course.courseName} (${course.units} units)`
      ).join('\n');
    }

    // Handle grades
    if (studentData.grades && typeof studentData.grades === 'object') {
      Object.keys(studentData.grades).forEach(subject => {
        const key = `grade_${subject.toLowerCase().replace(/\s+/g, '_')}`;
        templateData[key] = studentData.grades[subject];
      });
    }

    // Fill any remaining placeholders with empty strings
    placeholders.forEach(placeholder => {
      if (!(placeholder in templateData)) {
        templateData[placeholder] = '';
      }
    });

    return templateData;
  }

  /**
   * Extract text content from Word document
   */
  async extractTextContent(docBuffer) {
    try {
      const result = await mammoth.extractRawText({ buffer: docBuffer });
      return result.value;
    } catch (error) {
      console.error('Error extracting text content:', error);
      throw new Error('Failed to extract text content from document');
    }
  }

  /**
   * Validate Word document
   */
  async validateWordDocument(docBuffer) {
    try {
      const zip = new PizZip(docBuffer);
      const doc = new Docxtemplater(zip);
      // If this doesn't throw, it's a valid Word document
      return true;
    } catch (error) {
      throw new Error('Invalid Word document format');
    }
  }

  // Metadata management methods
  async saveTemplateMetadata(templateInfo) {
    const metadataPath = path.join(this.templatesDir, 'metadata.json');
    let metadata = {};
    
    try {
      const existingData = await fs.readFile(metadataPath, 'utf8');
      metadata = JSON.parse(existingData);
    } catch (error) {
      // File doesn't exist, start fresh
    }

    metadata[templateInfo.id] = templateInfo;
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  }

  async getTemplateMetadata(templateId) {
    const metadataPath = path.join(this.templatesDir, 'metadata.json');
    
    try {
      const data = await fs.readFile(metadataPath, 'utf8');
      const metadata = JSON.parse(data);
      return metadata[templateId];
    } catch (error) {
      return null;
    }
  }

  async saveDraftMetadata(draftInfo) {
    const metadataPath = path.join(this.draftsDir, 'metadata.json');
    let metadata = {};
    
    try {
      const existingData = await fs.readFile(metadataPath, 'utf8');
      metadata = JSON.parse(existingData);
    } catch (error) {
      // File doesn't exist, start fresh
    }

    metadata[draftInfo.id] = draftInfo;
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  }

  async getDraftMetadata(draftId) {
    const metadataPath = path.join(this.draftsDir, 'metadata.json');
    
    try {
      const data = await fs.readFile(metadataPath, 'utf8');
      const metadata = JSON.parse(data);
      return metadata[draftId];
    } catch (error) {
      return null;
    }
  }

  async saveFinalizedMetadata(finalizedInfo) {
    const metadataPath = path.join(this.finalizedDir, 'metadata.json');
    let metadata = {};
    
    try {
      const existingData = await fs.readFile(metadataPath, 'utf8');
      metadata = JSON.parse(existingData);
    } catch (error) {
      // File doesn't exist, start fresh
    }

    metadata[finalizedInfo.id] = finalizedInfo;
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  }

  async getFinalizedMetadata(finalizedId) {
    const metadataPath = path.join(this.finalizedDir, 'metadata.json');
    
    try {
      const data = await fs.readFile(metadataPath, 'utf8');
      const metadata = JSON.parse(data);
      return metadata[finalizedId];
    } catch (error) {
      return null;
    }
  }

  /**
   * List all templates
   */
  async listTemplates(documentType = null) {
    const metadataPath = path.join(this.templatesDir, 'metadata.json');
    
    try {
      const data = await fs.readFile(metadataPath, 'utf8');
      const metadata = JSON.parse(data);
      
      let templates = Object.values(metadata).filter(template => template.isActive);
      
      if (documentType) {
        templates = templates.filter(template => template.documentType === documentType);
      }
      
      return templates;
    } catch (error) {
      return [];
    }
  }

  /**
   * List drafts for a registrar
   */
  async listDrafts(registrarId, status = null) {
    const metadataPath = path.join(this.draftsDir, 'metadata.json');
    
    try {
      const data = await fs.readFile(metadataPath, 'utf8');
      const metadata = JSON.parse(data);
      
      let drafts = Object.values(metadata).filter(draft => 
        draft.registrarId === registrarId && !draft.deleted
      );
      
      if (status) {
        drafts = drafts.filter(draft => draft.status === status);
      }
      
      return drafts.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
    } catch (error) {
      return [];
    }
  }

  /**
   * List finalized documents for a registrar
   */
  async listFinalizedDocuments(registrarId, status = null) {
    const metadataPath = path.join(this.finalizedDir, 'metadata.json');
    
    try {
      const data = await fs.readFile(metadataPath, 'utf8');
      const metadata = JSON.parse(data);
      
      let documents = Object.values(metadata).filter(doc => doc.registrarId === registrarId);
      
      if (status) {
        documents = documents.filter(doc => doc.status === status);
      }
      
      return documents.sort((a, b) => new Date(b.finalizedDate) - new Date(a.finalizedDate));
    } catch (error) {
      return [];
    }
  }

  /**
   * Delete template (mark as inactive)
   */
  async deleteTemplate(templateId) {
    try {
      const templateInfo = await this.getTemplateMetadata(templateId);
      if (!templateInfo) {
        throw new Error('Template not found');
      }

      templateInfo.isActive = false;
      templateInfo.deletedDate = new Date().toISOString();

      await this.saveTemplateMetadata(templateInfo);

      return {
        success: true,
        message: 'Template deleted successfully'
      };
    } catch (error) {
      throw new Error(`Failed to delete template: ${error.message}`);
    }
  }

  /**
   * Get template statistics
   */
  async getTemplateStats() {
    try {
      const templates = await this.listTemplates();
      const draftsPath = path.join(this.draftsDir, 'metadata.json');
      const finalizedPath = path.join(this.finalizedDir, 'metadata.json');

      let totalDrafts = 0;
      let totalFinalized = 0;

      try {
        const draftsData = await fs.readFile(draftsPath, 'utf8');
        const draftsMetadata = JSON.parse(draftsData);
        totalDrafts = Object.values(draftsMetadata).filter(draft => !draft.deleted).length;
      } catch (error) {
        // No drafts file yet
      }

      try {
        const finalizedData = await fs.readFile(finalizedPath, 'utf8');
        const finalizedMetadata = JSON.parse(finalizedData);
        totalFinalized = Object.keys(finalizedMetadata).length;
      } catch (error) {
        // No finalized file yet
      }

      return {
        totalTemplates: templates.length,
        totalDrafts,
        totalFinalized,
        blockchainRegistered: 0 // Will be calculated properly when needed
      };
    } catch (error) {
      return {
        totalTemplates: 0,
        totalDrafts: 0,
        totalFinalized: 0,
        blockchainRegistered: 0
      };
    }
  }
}

module.exports = TemplateService;