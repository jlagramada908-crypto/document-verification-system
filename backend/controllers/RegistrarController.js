const jwt = require('jsonwebtoken');
const { ethers } = require('ethers');

class RegistrarController {

  /**
   * Add a new registrar (owner only)
   */
  static async addRegistrar(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      const { registrarAddress, institutionName } = req.body;

      if (!ethers.isAddress(registrarAddress)) {
        return res.status(400).json({
          error: 'Invalid Ethereum address'
        });
      }

      if (!institutionName || institutionName.trim() === '') {
        return res.status(400).json({
          error: 'Institution name is required'
        });
      }

      const result = await blockchain.addRegistrar(registrarAddress, institutionName.trim());

      if (result.success) {
        res.json({
          success: true,
          message: 'Registrar added successfully',
          data: {
            registrarAddress,
            institutionName: institutionName.trim(),
            transactionHash: result.transactionHash,
            blockNumber: result.blockNumber
          }
        });
      } else {
        res.status(500).json({
          error: 'Failed to add registrar',
          message: result.error
        });
      }

    } catch (error) {
      console.error('Error in addRegistrar:', error);
      res.status(500).json({
        error: 'Failed to add registrar',
        message: error.message
      });
    }
  }

  /**
   * Remove a registrar (owner only)
   */
  static async removeRegistrar(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      const { address } = req.params;

      if (!ethers.isAddress(address)) {
        return res.status(400).json({
          error: 'Invalid Ethereum address'
        });
      }

      const result = await blockchain.contract.removeRegistrar(address);
      const receipt = await result.wait();

      res.json({
        success: true,
        message: 'Registrar removed successfully',
        data: {
          registrarAddress: address,
          transactionHash: result.hash,
          blockNumber: receipt.blockNumber
        }
      });

    } catch (error) {
      console.error('Error in removeRegistrar:', error);
      res.status(500).json({
        error: 'Failed to remove registrar',
        message: error.message
      });
    }
  }

  /**
   * Check if an address is an active registrar
   */
  static async checkRegistrarStatus(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      const { address } = req.params;

      if (!ethers.isAddress(address)) {
        return res.status(400).json({
          error: 'Invalid Ethereum address'
        });
      }

      const isActive = await blockchain.isActiveRegistrar(address);

      res.json({
        success: true,
        address,
        isActiveRegistrar: isActive
      });

    } catch (error) {
      console.error('Error in checkRegistrarStatus:', error);
      res.status(500).json({
        error: 'Failed to check registrar status',
        message: error.message
      });
    }
  }

  /**
   * Get detailed registrar information
   */
  static async getRegistrarInfo(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      const { address } = req.params;

      if (!ethers.isAddress(address)) {
        return res.status(400).json({
          error: 'Invalid Ethereum address'
        });
      }

      const [institutionName, isActive, documentsIssued, dateAdded] = 
        await blockchain.contract.getRegistrarInfo(address);

      if (!isActive && institutionName === '') {
        return res.status(404).json({
          error: 'Registrar not found'
        });
      }

      res.json({
        success: true,
        registrar: {
          address,
          institutionName,
          isActive,
          documentsIssued: documentsIssued.toString(),
          dateAdded: new Date(Number(dateAdded) * 1000).toISOString()
        }
      });

    } catch (error) {
      console.error('Error in getRegistrarInfo:', error);
      res.status(500).json({
        error: 'Failed to get registrar information',
        message: error.message
      });
    }
  }

  /**
   * List all registrars (owner only)
   */
  static async listAllRegistrars(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      
      // Note: This is a simplified implementation
      // In a real scenario, you'd want to emit events and track registrars
      // or implement additional contract functions
      
      const stats = await blockchain.getContractStats();
      
      res.json({
        success: true,
        message: 'Use blockchain events or additional contract methods to get full registrar list',
        totalRegistrars: stats.totalRegistrars,
        suggestion: 'Implement getRegistrarList() function in smart contract for complete list'
      });

    } catch (error) {
      console.error('Error in listAllRegistrars:', error);
      res.status(500).json({
        error: 'Failed to list registrars',
        message: error.message
      });
    }
  }

  /**
   * Registrar login/authentication
   */
  static async loginRegistrar(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      const { address, signature, message } = req.body;

      if (!ethers.isAddress(address)) {
        return res.status(400).json({
          error: 'Invalid Ethereum address'
        });
      }

      // Verify the registrar is active
      const isActive = await blockchain.isActiveRegistrar(address);
      if (!isActive) {
        return res.status(401).json({
          error: 'Address is not an active registrar'
        });
      }

      // Verify signature (basic implementation)
      // In production, implement proper message signing verification
      if (signature && message) {
        try {
          const recoveredAddress = ethers.verifyMessage(message, signature);
          if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
            return res.status(401).json({
              error: 'Invalid signature'
            });
          }
        } catch (sigError) {
          return res.status(401).json({
            error: 'Signature verification failed'
          });
        }
      }

      // Get registrar info
      const [institutionName, , documentsIssued, dateAdded] = 
        await blockchain.contract.getRegistrarInfo(address);

      // Generate JWT token
      const token = jwt.sign(
        { 
          address, 
          institutionName,
          role: 'registrar'
        },
        process.env.JWT_SECRET || 'your-secret-key',
        { expiresIn: '24h' }
      );

      res.json({
        success: true,
        message: 'Login successful',
        token,
        registrar: {
          address,
          institutionName,
          documentsIssued: documentsIssued.toString(),
          dateAdded: new Date(Number(dateAdded) * 1000).toISOString()
        }
      });

    } catch (error) {
      console.error('Error in loginRegistrar:', error);
      res.status(500).json({
        error: 'Login failed',
        message: error.message
      });
    }
  }

  /**
   * Get current registrar's profile
   */
  static async getRegistrarProfile(req, res) {
    try {
      const blockchain = req.app.locals.blockchain;
      const registrarAddress = req.registrar.address;

      const [institutionName, isActive, documentsIssued, dateAdded] = 
        await blockchain.contract.getRegistrarInfo(registrarAddress);

      // Get registrar's documents
      const documentHashes = await blockchain.contract.getRegistrarDocuments(registrarAddress);

      res.json({
        success: true,
        profile: {
          address: registrarAddress,
          institutionName,
          isActive,
          documentsIssued: documentsIssued.toString(),
          dateAdded: new Date(Number(dateAdded) * 1000).toISOString(),
          totalDocumentHashes: documentHashes.length
        }
      });

    } catch (error) {
      console.error('Error in getRegistrarProfile:', error);
      res.status(500).json({
        error: 'Failed to get registrar profile',
        message: error.message
      });
    }
  }

  /**
   * Update registrar profile (limited fields)
   */
  static async updateRegistrarProfile(req, res) {
    try {
      // Note: Blockchain data is immutable, so we can only update off-chain data
      // This would typically involve a separate database for profile preferences
      
      res.json({
        success: true,
        message: 'Profile updates are limited due to blockchain immutability',
        suggestion: 'Only off-chain preferences can be updated'
      });

    } catch (error) {
      console.error('Error in updateRegistrarProfile:', error);
      res.status(500).json({
        error: 'Failed to update registrar profile',
        message: error.message
      });
    }
  }
}

module.exports = RegistrarController;