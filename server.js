// server.js - Node.js Express Server for Amrit Medicine Distribution System
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { google } = require('googleapis');
const multer = require('multer');
const path = require('path');
const { Readable } = require('stream');

const app = express();

// ===== MIDDLEWARE CONFIGURATION =====
app.use(helmet({
  contentSecurityPolicy: false, // Allow camera access
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Increase payload limit for large files/photos
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// ===== GOOGLE SHEETS & DRIVE AUTHENTICATION =====
let auth = null;
let sheets = null;
let drive = null;

// Initialize Google APIs with service account
function initializeGoogleApis() {
  try {
    console.log('🔑 Initializing Google APIs...');
    
    // Check if credentials exist
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      console.error('❌ Google credentials not found in environment variables');
      return false;
    }

    // Format private key properly
    const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
    
    auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: privateKey,
      },
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive'
      ],
    });

    sheets = google.sheets({ version: 'v4', auth });
    drive = google.drive({ version: 'v3', auth });
    
    console.log('✅ Google APIs initialized successfully');
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize Google APIs:', error.message);
    return false;
  }
}

// Initialize on startup
const googleApisReady = initializeGoogleApis();

// ===== MULTER CONFIGURATION FOR FILE UPLOADS =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allowed file types
    const allowedTypes = [
      'image/jpeg', 'image/jpg', 'image/png', 'image/gif',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images, PDF, and DOC files are allowed.'));
    }
  }
});

// ===== HELPER FUNCTIONS =====

/**
 * Upload file to Google Drive
 */
async function uploadToDrive(fileBuffer, fileName, mimeType, category) {
  try {
    console.log('📤 Uploading to Google Drive...');
    
    if (!drive) {
      throw new Error('Google Drive not initialized');
    }
    
    // Create timestamp for unique filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeCategory = category.replace(/[^a-zA-Z0-9]/g, '_');
    const uniqueFileName = `Medicine_${safeCategory}_${timestamp}_${fileName}`;
    
    // Find or create "Medicine Photos" folder
    let folderId = null;
    
    try {
      const folderResponse = await drive.files.list({
        q: "name='Medicine Photos' and mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields: 'files(id, name)',
        spaces: 'drive'
      });
      
      if (folderResponse.data.files && folderResponse.data.files.length > 0) {
        folderId = folderResponse.data.files[0].id;
        console.log('📁 Found existing folder:', folderId);
      }
    } catch (error) {
      console.log('⚠️ Error checking folder:', error.message);
    }
    
    // Create folder if it doesn't exist
    if (!folderId) {
      try {
        const folderMetadata = {
          name: 'Medicine Photos',
          mimeType: 'application/vnd.google-apps.folder',
        };
        
        const folder = await drive.files.create({
          resource: folderMetadata,
          fields: 'id',
        });
        
        folderId = folder.data.id;
        console.log('📁 Created new folder:', folderId);
      } catch (error) {
        console.error('❌ Failed to create folder:', error.message);
        throw error;
      }
    }
    
    // Create readable stream from buffer
    const bufferStream = new Readable();
    bufferStream.push(fileBuffer);
    bufferStream.push(null);
    
    // Upload file to Drive
    const fileMetadata = {
      name: uniqueFileName,
      parents: [folderId],
    };
    
    const media = {
      mimeType: mimeType,
      body: bufferStream,
    };
    
    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink, name',
    });
    
    console.log('✅ File uploaded to Drive, ID:', file.data.id);
    
    // Set file permissions to anyone with link can view
    try {
      await drive.permissions.create({
        fileId: file.data.id,
        requestBody: {
          role: 'reader',
          type: 'anyone',
        },
      });
      console.log('✅ File permissions set to public');
    } catch (permError) {
      console.warn('⚠️ Could not set public permissions:', permError.message);
      // Continue even if permissions fail - file might still be accessible
    }
    
    // Return Google Sheets HYPERLINK formula
    const fileUrl = file.data.webViewLink || `https://drive.google.com/file/d/${file.data.id}/view`;
    return `=HYPERLINK("${fileUrl}", "📷 View Photo")`;
    
  } catch (error) {
    console.error('❌ Drive upload error:', error);
    throw error;
  }
}

// ===== API ENDPOINTS =====

/**
 * GET /api/employees - Fetch employee data from Google Sheets
 */
app.get('/api/employees', async (req, res) => {
  try {
    console.log('📊 Fetching employee data...');
    
    if (!sheets) {
      if (!initializeGoogleApis()) {
        return res.status(500).json({ error: 'Google Sheets API not initialized' });
      }
    }
    
    const spreadsheetId = process.env.SPREADSHEET_ID;
    if (!spreadsheetId) {
      return res.status(500).json({ error: 'Spreadsheet ID not configured' });
    }
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: 'Employee Master Data!A2:C',
    });
    
    const rows = response.data.values || [];
    const employees = [];
    
    rows.forEach((row, index) => {
      if (row[0] && row[1]) { // Name and Code exist
        employees.push({
          name: String(row[0] || '').trim(),
          code: String(row[1] || '').trim(),
          department: String(row[2] || '').trim()
        });
      }
    });
    
    console.log(`✅ Loaded ${employees.length} employees`);
    res.json(employees);
    
  } catch (error) {
    console.error('❌ Error fetching employees:', error);
    res.status(500).json({ 
      error: 'Failed to fetch employee data',
      details: error.message 
    });
  }
});

/**
 * GET /api/medicines - Fetch medicine rates from Google Sheets
 */
app.get('/api/medicines', async (req, res) => {
  try {
    console.log('💊 Fetching medicine rates...');
    
    if (!sheets) {
      if (!initializeGoogleApis()) {
        return res.status(500).json({ error: 'Google Sheets API not initialized' });
      }
    }
    
    const spreadsheetId = process.env.SPREADSHEET_ID;
    if (!spreadsheetId) {
      return res.status(500).json({ error: 'Spreadsheet ID not configured' });
    }
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: 'Rate Sheet!A2:D',
    });
    
    const rows = response.data.values || [];
    const medicines = [];
    
    rows.forEach((row, index) => {
      const sku = String(row[0] || '').trim();
      const category = String(row[1] || '').trim();
      const name = String(row[2] || '').trim();
      const rate = parseFloat(row[3]) || 0;
      
      if (sku && name && rate > 0) {
        medicines.push({
          sku: sku,
          category: category,
          name: name,
          rate: rate
        });
      }
    });
    
    console.log(`✅ Loaded ${medicines.length} medicines`);
    res.json(medicines);
    
  } catch (error) {
    console.error('❌ Error fetching medicines:', error);
    res.status(500).json({ 
      error: 'Failed to fetch medicine data',
      details: error.message 
    });
  }
});

/**
 * POST /api/submit - Submit form data to Google Sheets
 */
app.post('/api/submit', upload.single('file'), async (req, res) => {
  try {
    console.log('📤 Form submission started...');
    console.log('Request body keys:', Object.keys(req.body));
    console.log('File received:', req.file ? 'Yes' : 'No');
    
    // Extract form data
    const formData = req.body;
    
    // Validate required fields
    if (!formData.category) {
      return res.status(400).json({ 
        success: false, 
        message: '❌ Category is required' 
      });
    }
    
    if (!formData.employeeName) {
      return res.status(400).json({ 
        success: false, 
        message: '❌ Name is required' 
      });
    }
    
    if (!formData.department) {
      return res.status(400).json({ 
        success: false, 
        message: '❌ Department is required' 
      });
    }
    
    if (!formData.remarks) {
      return res.status(400).json({ 
        success: false, 
        message: '❌ Remarks are required' 
      });
    }
    
    // Parse medicines data
    let medicines = [];
    try {
      if (typeof formData.medicines === 'string') {
        medicines = JSON.parse(formData.medicines);
      } else if (Array.isArray(formData.medicines)) {
        medicines = formData.medicines;
      } else {
        throw new Error('Invalid medicines format');
      }
    } catch (e) {
      console.error('❌ Error parsing medicines:', e);
      return res.status(400).json({ 
        success: false, 
        message: '❌ Invalid medicines data format' 
      });
    }
    
    if (!medicines || medicines.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: '❌ No medicines provided' 
      });
    }
    
    console.log(`📋 Processing ${medicines.length} medicines`);
    
    // Initialize Google APIs if needed
    if (!sheets || !drive) {
      if (!initializeGoogleApis()) {
        return res.status(500).json({ 
          success: false, 
          message: '❌ Google APIs not initialized' 
        });
      }
    }
    
    // Handle photo/file upload to Google Drive
    let photoLink = 'No photo uploaded';
    
    try {
      // Case 1: Camera photo (base64 data URL)
      if (formData.photoDataUrl && 
          typeof formData.photoDataUrl === 'string' && 
          formData.photoDataUrl.startsWith('data:image')) {
        
        console.log('📷 Processing camera photo upload...');
        
        // Extract base64 data from data URL
        const matches = formData.photoDataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (matches && matches.length === 3) {
          const mimeType = matches[1];
          const base64Data = matches[2];
          const fileBuffer = Buffer.from(base64Data, 'base64');
          
          photoLink = await uploadToDrive(
            fileBuffer,
            'camera_photo.jpg',
            mimeType,
            formData.category
          );
          console.log('✅ Camera photo uploaded');
        }
      }
      // Case 2: File upload (from multer)
      else if (req.file) {
        console.log('📎 Processing file upload:', req.file.originalname);
        
        photoLink = await uploadToDrive(
          req.file.buffer,
          req.file.originalname,
          req.file.mimetype,
          formData.category
        );
        console.log('✅ File uploaded');
      }
    } catch (uploadError) {
      console.error('❌ Upload to Drive failed:', uploadError);
      photoLink = 'Photo upload failed: ' + uploadError.message;
      // Continue with submission even if upload fails
    }
    
    // Prepare data for Google Sheets
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const timestamp = new Date().toISOString();
    
    // Generate unique Entry ID
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const entryId = `${year}${month}${day}${hours}${minutes}${random}`;
    
    // Create rows for each medicine
    const rows = [];
    medicines.forEach(med => {
      const quantity = parseInt(med.quantity) || 0;
      const rate = parseFloat(med.rate) || 0;
      const totalAmount = quantity * rate;
      
      rows.push([
        timestamp,                          // A: Timestamp
        formData.category,                   // B: Category
        formData.employeeCode || '',         // C: Employee Code
        formData.employeeName,                // D: Name
        formData.department,                  // E: Department
        med.name || 'Unknown',                // F: Medicine Name
        quantity,                              // G: Quantity
        rate.toFixed(2),                       // H: Rate per Unit
        totalAmount.toFixed(2),                 // I: Total Amount
        med.sku || '',                           // J: SKU Code
        photoLink,                                // K: Photo Link
        formData.remarks,                          // L: Remarks
        entryId                                     // M: Entry ID
      ]);
    });
    
    console.log(`📝 Preparing to append ${rows.length} rows to sheet`);
    
    // Check if Responses sheet exists, create if not
    try {
      // First, try to get sheet metadata to check if Responses sheet exists
      const sheetMetadata = await sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId,
        fields: 'sheets.properties'
      });
      
      const sheets_list = sheetMetadata.data.sheets;
      const responsesSheetExists = sheets_list.some(
        sheet => sheet.properties.title === 'Responses'
      );
      
      if (!responsesSheetExists) {
        console.log('📄 Creating new Responses sheet...');
        
        // Create new sheet
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: spreadsheetId,
          resource: {
            requests: [{
              addSheet: {
                properties: {
                  title: 'Responses',
                  gridProperties: {
                    rowCount: 1000,
                    columnCount: 13
                  }
                }
              }
            }]
          }
        });
        
        // Add headers
        await sheets.spreadsheets.values.update({
          spreadsheetId: spreadsheetId,
          range: 'Responses!A1:M1',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              'Timestamp', 'Category', 'Employee Code', 'Name', 'Department',
              'Medicine Name', 'Quantity', 'Rate per Unit', 'Total Amount', 
              'SKU Code', 'Photo Link', 'Remarks', 'Entry ID'
            ]]
          }
        });
        
        console.log('✅ Responses sheet created with headers');
      }
    } catch (sheetError) {
      console.error('❌ Error checking/creating sheet:', sheetError);
      // Continue anyway - sheet might exist
    }
    
    // Append data to sheet
    const appendResponse = await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId,
      range: 'Responses!A:M',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: rows
      }
    });
    
    console.log('✅ Data appended to sheet:', appendResponse.data);
    console.log(`✅ Form submitted successfully - ${rows.length} rows added with Entry ID: ${entryId}`);
    
    // Return success response
    res.json({
      success: true,
      message: `✅ Success! ${medicines.length} medicines saved in ${rows.length} rows! Entry ID: ${entryId}`,
      entryId: entryId,
      rowsAdded: rows.length
    });
    
  } catch (error) {
    console.error('❌ Submission error:', error);
    res.status(500).json({ 
      success: false, 
      message: `❌ Submission failed: ${error.message}` 
    });
  }
});

/**
 * GET /api/health - Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    googleApisReady: googleApisReady,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// ===== ERROR HANDLING MIDDLEWARE =====
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: '❌ File too large. Maximum size is 5MB.'
      });
    }
  }
  
  res.status(500).json({
    success: false,
    message: `❌ Server error: ${err.message}`
  });
});

// ===== SERVE FRONTEND FOR ALL OTHER ROUTES =====
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;

// Only start server if not in Vercel serverless environment
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Server is running on port ${PORT}`);
    console.log(`📍 Local: http://localhost:${PORT}`);
    console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

// Export for Vercel serverless
module.exports = app;