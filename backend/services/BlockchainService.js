const { ethers } = require('ethers');
const crypto = require('crypto');

// UPDATED CONTRACT ABI - Simplified Hash-Only Version
const CONTRACT_ABI = [
  // Events
  "event DocumentRegistered(bytes32 indexed documentHash, uint256 timestamp)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  
  // State variables
  "function owner() view returns (address)",
  "function totalDocuments() view returns (uint256)",
  
  // Document functions - SIMPLIFIED
  "function registerDocument(bytes32 _documentHash)",
  "function verifyDocument(bytes32 _documentHash) view returns (bool exists, uint256 timestamp)",
  
  // Batch function - SIMPLIFIED
  "function batchRegisterDocuments(bytes32[] _documentHashes)",
  
  // Stats function - SIMPLIFIED (no totalRegistrars)
  "function getContractStats() view returns (uint256 _totalDocuments, address _contractOwner)",
  
  // Ownership
  "function transferOwnership(address _newOwner)"
];

class BlockchainService {
  constructor() {
    this.provider = null;
    this.contract = null;
    this.signer = null;
    this.contractAddress = null;
    this.initialized = false;
  }

  /**
   * Initialize the blockchain service
   * @param {string} providerUrl - RPC URL (default: localhost)
   * @param {string} privateKey - Private key for transactions (optional for read-only)
   * @param {string} contractAddress - Deployed contract address
   */
  async initialize(providerUrl = 'http://127.0.0.1:8545', privateKey = null, contractAddress = null) {
    try {
      // Connect to provider
      this.provider = new ethers.JsonRpcProvider(providerUrl);
      
      // Test connection
      const network = await this.provider.getNetwork();
      console.log('Connected to network:', network.name, 'Chain ID:', network.chainId.toString());

      // Set up signer if private key provided
      if (privateKey) {
        this.signer = new ethers.Wallet(privateKey, this.provider);
        console.log('Signer address:', this.signer.address);
      } else {
        // Use first account from hardhat node (for testing)
        try {
          this.signer = await this.provider.getSigner(0);
          console.log('Using default signer:', await this.signer.getAddress());
        } catch (error) {
          console.log('No signer available - read-only mode');
          this.signer = null;
        }
      }

      // Set contract address
      if (contractAddress) {
        this.contractAddress = contractAddress;
      } else if (process.env.CONTRACT_ADDRESS) {
        this.contractAddress = process.env.CONTRACT_ADDRESS;
      } else {
        throw new Error('Contract address must be provided');
      }

      // Connect to contract
      this.contract = new ethers.Contract(
        this.contractAddress,
        CONTRACT_ABI,
        this.signer || this.provider
      );

      // Verify contract is deployed
      const code = await this.provider.getCode(this.contractAddress);
      if (code === '0x') {
        throw new Error('Contract not found at address: ' + this.contractAddress);
      }

      this.initialized = true;
      console.log('Blockchain service initialized successfully');
      console.log('Contract address:', this.contractAddress);
      
      // Get contract stats
      try {
        const stats = await this.getContractStats();
        console.log('Contract stats:', stats);
      } catch (error) {
        console.error('Error getting contract stats:', error);
        // Don't throw - allow initialization to continue
      }

    } catch (error) {
      console.error('Failed to initialize blockchain service:', error);
      throw error;
    }
  }

  /**
   * Generate Keccak-256 hash of document content
   * @param {string} content - Document content to hash
   * @returns {string} - Hex string of hash
   */
  generateDocumentHash(content) {
    return ethers.keccak256(ethers.toUtf8Bytes(content));
  }

  /**
   * Register a new document on the blockchain (SIMPLIFIED - HASH ONLY)
   * @param {Object} documentData - Document information
   * @returns {Object} - Transaction result
   */
  async registerDocument(documentData) {
    if (!this.initialized || !this.signer) {
      throw new Error('Service not initialized or no signer available');
    }

    try {
      // Extract document hash (can be pre-computed or content to hash)
      let documentHash;
      
      if (documentData.documentContent) {
        // If content is provided, hash it
        if (documentData.documentContent.startsWith('0x')) {
          // Already a hash
          documentHash = documentData.documentContent;
        } else {
          // Hash the content
          documentHash = this.generateDocumentHash(documentData.documentContent);
        }
      } else if (documentData.documentHash) {
        // Direct hash provided
        documentHash = documentData.documentHash;
      } else {
        throw new Error('Either documentContent or documentHash must be provided');
      }
      
      console.log('Registering document with hash:', documentHash);

      // Call smart contract - ONLY HASH PARAMETER
      const tx = await this.contract.registerDocument(documentHash);

      console.log('Transaction sent:', tx.hash);

      // Wait for confirmation
      const receipt = await tx.wait();
      console.log('Document registered successfully. Block:', receipt.blockNumber);

      return {
        success: true,
        transactionHash: tx.hash,
        blockNumber: receipt.blockNumber,
        documentHash: documentHash,
        gasUsed: receipt.gasUsed.toString()
      };

    } catch (error) {
      console.error('Error registering document:', error);
      return {
        success: false,
        error: error.message,
        code: error.code
      };
    }
  }

  /**
   * Verify a document using its hash (SIMPLIFIED - RETURNS ONLY EXISTS AND TIMESTAMP)
   * @param {string} documentHash - Hash of the document to verify
   * @returns {Object} - Verification result
   */
  async verifyDocument(documentHash) {
    if (!this.initialized) {
      throw new Error('Service not initialized');
    }

    try {
      console.log('Verifying document with hash:', documentHash);

      const result = await this.contract.verifyDocument(documentHash);

      // result is now [exists, timestamp]
      const exists = result[0];
      const timestamp = result[1];

      if (exists) {
        return {
          success: true,
          verified: true,
          document: {
            exists: true,
            timestamp: Number(timestamp),
            dateRegistered: new Date(Number(timestamp) * 1000),
            documentHash: documentHash
          }
        };
      } else {
        return {
          success: true,
          verified: false,
          message: 'Document not found on blockchain'
        };
      }

    } catch (error) {
      console.error('Error verifying document:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Verify document from uploaded PDF content
   * @param {string} pdfContent - Content extracted from PDF
   * @returns {Object} - Verification result
   */
  async verifyDocumentFromContent(pdfContent) {
    const documentHash = this.generateDocumentHash(pdfContent);
    return await this.verifyDocument(documentHash);
  }

  /**
   * Batch register multiple documents (SIMPLIFIED - HASHES ONLY)
   * @param {Array} documentHashes - Array of document hashes
   * @returns {Object} - Transaction result
   */
  async batchRegisterDocuments(documentHashes) {
    if (!this.initialized || !this.signer) {
      throw new Error('Service not initialized or no signer available');
    }

    try {
      console.log(`Batch registering ${documentHashes.length} documents...`);

      const tx = await this.contract.batchRegisterDocuments(documentHashes);
      const receipt = await tx.wait();

      return {
        success: true,
        transactionHash: tx.hash,
        blockNumber: receipt.blockNumber,
        documentsRegistered: documentHashes.length,
        gasUsed: receipt.gasUsed.toString()
      };

    } catch (error) {
      console.error('Error batch registering documents:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get contract statistics (SIMPLIFIED - NO REGISTRAR COUNT)
   * @returns {Object} - Contract stats
   */
  async getContractStats() {
    if (!this.initialized) {
      throw new Error('Service not initialized');
    }

    try {
      const [totalDocuments, contractOwner] = await this.contract.getContractStats();
      return {
        totalDocuments: totalDocuments.toString(),
        contractOwner: contractOwner
      };
    } catch (error) {
      console.error('Error getting contract stats:', error);
      return null;
    }
  }

  /**
   * Check if connected signer is the contract owner
   * @returns {boolean} - True if signer is owner
   */
  async isOwner() {
    if (!this.initialized || !this.signer) {
      return false;
    }

    try {
      const owner = await this.contract.owner();
      const signerAddress = await this.signer.getAddress();
      return owner.toLowerCase() === signerAddress.toLowerCase();
    } catch (error) {
      console.error('Error checking owner status:', error);
      return false;
    }
  }

  /**
   * Listen for document registration events (SIMPLIFIED)
   * @param {Function} callback - Function to call when event received
   */
  listenForDocumentEvents(callback) {
    if (!this.initialized) {
      throw new Error('Service not initialized');
    }

    this.contract.on('DocumentRegistered', (documentHash, timestamp, event) => {
      const eventData = {
        documentHash: documentHash,
        timestamp: new Date(Number(timestamp) * 1000),
        transactionHash: event.log.transactionHash,
        blockNumber: event.log.blockNumber
      };

      callback(eventData);
    });

    console.log('Started listening for DocumentRegistered events');
  }

  /**
   * Stop listening for events
   */
  stopListening() {
    if (this.contract) {
      this.contract.removeAllListeners();
      console.log('Stopped listening for events');
    }
  }

  /**
   * Get the current contract address
   * @returns {string} - Contract address
   */
  getContractAddress() {
    return this.contractAddress;
  }

  /**
   * Get the current signer address
   * @returns {string} - Signer address
   */
  async getSignerAddress() {
    if (this.signer) {
      return await this.signer.getAddress();
    }
    return null;
  }

  /**
   * Transfer contract ownership (OWNER ONLY)
   * @param {string} newOwnerAddress - Address of new owner
   * @returns {Object} - Transaction result
   */
  async transferOwnership(newOwnerAddress) {
    if (!this.initialized || !this.signer) {
      throw new Error('Service not initialized or no signer available');
    }

    try {
      console.log('Transferring ownership to:', newOwnerAddress);

      const tx = await this.contract.transferOwnership(newOwnerAddress);
      const receipt = await tx.wait();

      return {
        success: true,
        transactionHash: tx.hash,
        blockNumber: receipt.blockNumber,
        newOwner: newOwnerAddress
      };

    } catch (error) {
      console.error('Error transferring ownership:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get total documents count
   * @returns {number} - Total documents registered
   */
  async getTotalDocuments() {
    if (!this.initialized) {
      throw new Error('Service not initialized');
    }

    try {
      const total = await this.contract.totalDocuments();
      return Number(total);
    } catch (error) {
      console.error('Error getting total documents:', error);
      return 0;
    }
  }

  /**
   * Get contract owner address
   * @returns {string} - Owner address
   */
  async getOwner() {
    if (!this.initialized) {
      throw new Error('Service not initialized');
    }

    try {
      return await this.contract.owner();
    } catch (error) {
      console.error('Error getting owner:', error);
      return null;
    }
  }
}

module.exports = BlockchainService;