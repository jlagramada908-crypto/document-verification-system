const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

class DatabaseService {
  static pool = null;

  static async initialize() {
    try {
      // Create connection pool
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? {
          rejectUnauthorized: false
        } : false
      });

      // Test connection
      const client = await this.pool.connect();
      console.log('✅ PostgreSQL Database connected successfully');
      client.release();

      // Create tables
      await this.createTables();

      // Seed initial data
      await this.seedData();

      return this.pool;
    } catch (error) {
      console.error('❌ Database connection failed:', error);
      throw error;
    }
  }

  static async createTables() {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Create registrars table
      await client.query(`
        CREATE TABLE IF NOT EXISTS registrars (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          full_name VARCHAR(100),
          institution_name VARCHAR(200),
          email VARCHAR(100),
          wallet_address VARCHAR(42),
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create students table
      await client.query(`
        CREATE TABLE IF NOT EXISTS students (
          id SERIAL PRIMARY KEY,
          student_id VARCHAR(50) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          full_name VARCHAR(100),
          email VARCHAR(100),
          phone VARCHAR(20),
          program VARCHAR(100),
          year_level VARCHAR(20),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create documents table - UPDATED WITH CONTENT HASH COLUMNS
      await client.query(`
        CREATE TABLE IF NOT EXISTS documents (
          id SERIAL PRIMARY KEY,
          document_hash VARCHAR(66) UNIQUE NOT NULL,
          student_name VARCHAR(100) NOT NULL,
          student_id VARCHAR(50) NOT NULL,
          program VARCHAR(100) NOT NULL,
          document_type VARCHAR(50) NOT NULL,
          date_issued TIMESTAMP NOT NULL,
          original_file_name VARCHAR(255) NOT NULL,
          processed_file_path VARCHAR(500) NOT NULL,
          watermarked_file_path VARCHAR(500),
          original_file_path VARCHAR(500),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          blockchain_tx_hash VARCHAR(66),
          block_number INTEGER,
          verified BOOLEAN DEFAULT false,
          registrar_id INTEGER REFERENCES registrars(id),
          -- ✅ ADD THESE COLUMNS FOR VERIFICATION:
          content_hash VARCHAR(66),
          processed_content_hash VARCHAR(66),
          watermarked_content_hash VARCHAR(66)
        )
      `);

      // Create document_requests table
      await client.query(`
        CREATE TABLE IF NOT EXISTS document_requests (
          id SERIAL PRIMARY KEY,
          student_id VARCHAR(50),
          document_type VARCHAR(50),
          status VARCHAR(20) DEFAULT 'pending',
          requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          processed_at TIMESTAMP,
          processed_by INTEGER REFERENCES registrars(id),
          notes TEXT
        )
      `);

      // Create templates table
      await client.query(`
        CREATE TABLE IF NOT EXISTS templates (
          id SERIAL PRIMARY KEY,
          template_id VARCHAR(100) UNIQUE,
          document_type VARCHAR(50),
          template_name VARCHAR(200),
          file_path VARCHAR(500),
          is_active BOOLEAN DEFAULT true,
          metadata JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query('COMMIT');
      console.log('✅ Database tables created successfully');

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Error creating tables:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async seedData() {
    const client = await this.pool.connect();

    try {
      // Check if admin exists
      const adminCheck = await client.query(
        'SELECT * FROM registrars WHERE username = $1',
        ['admin']
      );

      if (adminCheck.rows.length === 0) {
        const hashedPassword = await bcrypt.hash('admin123', 10);
        await client.query(
          `INSERT INTO registrars (username, password, full_name, institution_name, email) 
           VALUES ($1, $2, $3, $4, $5)`,
          [
            'admin',
            hashedPassword,
            'System Administrator',
            'President Ramon Magsaysay State University',
            'admin@prmsu.edu.ph'
          ]
        );
        console.log('✅ Default admin created: username=admin, password=admin123');
      } else {
        console.log('✅ Admin account already exists');
      }

      // Check if test student exists
      const studentCheck = await client.query(
        'SELECT * FROM students WHERE student_id = $1',
        ['2021-00001']
      );

      if (studentCheck.rows.length === 0) {
        const hashedPassword = await bcrypt.hash('student123', 10);
        await client.query(
          `INSERT INTO students (student_id, password, full_name, email, program, year_level) 
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            '2021-00001',
            hashedPassword,
            'Juan Dela Cruz',
            'juan@student.prmsu.edu.ph',
            'BS Computer Science',
            '4th Year'
          ]
        );
        console.log('✅ Test student created: student_id=2021-00001, password=student123');
      } else {
        console.log('✅ Test student already exists');
      }

    } catch (error) {
      console.error('❌ Error seeding data:', error);
    } finally {
      client.release();
    }
  }

  // Helper method for queries
  static async query(text, params) {
    return this.pool.query(text, params);
  }

  // Graceful shutdown
  static async close() {
    if (this.pool) {
      await this.pool.end();
      console.log('✅ Database connection closed');
    }
  }
}

module.exports = DatabaseService;