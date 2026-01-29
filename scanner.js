const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc, getDocs, query, where, serverTimestamp } = require('firebase/firestore');
const { getStorage, ref, uploadBytes, getDownloadURL } = require('firebase/storage');
const axios = require('axios');
const cheerio = require('cheerio');

// Firebase Config from GitHub Secrets
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

// Customs website URLs
const CUSTOMS_BASE_URL = 'https://shaarolami-query.customs.mof.gov.il';
const CUSTOMS_BOOK_URL = `${CUSTOMS_BASE_URL}/CustomspilotWeb/he/CustomsBook/Home/LinkReports`;

// File categories detection
function detectCategory(fileName) {
  const name = fileName.toLowerCase();
  
  if (name.includes('תוספת') || name.includes('supplement') || name.includes('wto')) {
    return { category: 'supplement', label: 'תוספת' };
  }
  if (name.includes('נוהל') || name.includes('procedure') || name.includes('פקודה')) {
    return { category: 'procedure', label: 'נהלים' };
  }
  if (name.includes('הסכם') || name.includes('agreement') || name.includes('fta')) {
    return { category: 'agreement', label: 'הסכם' };
  }
  return { category: 'tariff', label: 'תעריף' };
}

// Check if file already exists in database
async function fileExists(fileName) {
  try {
    const q = query(collection(db, 'files'), where('name', '==', fileName));
    const snapshot = await getDocs(q);
    return !snapshot.empty;
  } catch (error) {
    console.error('Error checking file existence:', error);
    return false;
  }
}

// Download file from URL
async function downloadFile(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 120000, // 2 minutes timeout
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error(`Error downloading ${url}:`, error.message);
    return null;
  }
}

// Upload file to Firebase Storage
async function uploadToFirebase(fileName, fileBuffer, category) {
  try {
    const timestamp = Date.now();
    const storagePath = `documents/${category}/${timestamp}_${fileName}`;
    const storageRef = ref(storage, storagePath);
    
    // Upload to Storage
    await uploadBytes(storageRef, fileBuffer, {
      contentType: 'application/pdf'
    });
    
    const downloadURL = await getDownloadURL(storageRef);
    
    // Save metadata to Firestore
    const docRef = await addDoc(collection(db, 'files'), {
      name: fileName,
      size: fileBuffer.length,
      type: 'application/pdf',
      category: category,
      url: downloadURL,
      path: storagePath,
      uploadedAt: serverTimestamp(),
      source: 'auto-scanner'
    });
    
    console.log(`✅ Uploaded: ${fileName} (${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
    return docRef.id;
    
  } catch (error) {
    console.error(`❌ Error uploading ${fileName}:`, error.message);
    return null;
  }
}

// Scrape customs website for PDF links
async function scrapeCustomsLinks() {
  console.log('🔍 Scanning customs website...');
  
  try {
    const response = await axios.get(CUSTOMS_BOOK_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    const links = [];
    
    // Find all links that might be PDF downloads
    $('a').each((i, elem) => {
      const href = $(elem).attr('href');
      const text = $(elem).text().trim();
      
      if (href && (href.includes('Download') || href.includes('Report') || href.includes('pdf'))) {
        const fullUrl = href.startsWith('http') ? href : `${CUSTOMS_BASE_URL}${href}`;
        links.push({ url: fullUrl, name: text || `file_${i}` });
      }
    });
    
    console.log(`📋 Found ${links.length} potential download links`);
    return links;
    
  } catch (error) {
    console.error('Error scraping customs website:', error.message);
    return [];
  }
}

// Known direct PDF URLs (backup list)
const KNOWN_PDF_SECTIONS = [
  { name: 'Section_I.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=1' },
  { name: 'Section_II.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=2' },
  { name: 'Section_III.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=3' },
  { name: 'Section_IV.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=4' },
  { name: 'Section_V.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=5' },
  { name: 'Section_VI.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=6' },
  { name: 'Section_VII.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=7' },
  { name: 'Section_VIII.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=8' },
  { name: 'Section_IX.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=9' },
  { name: 'Section_X.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=10' },
  { name: 'Section_XI.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=11' },
  { name: 'Section_XII.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=12' },
  { name: 'Section_XIII.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=13' },
  { name: 'Section_XIV.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=14' },
  { name: 'Section_XV.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=15' },
  { name: 'Section_XVI.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=16' },
  { name: 'Section_XVII.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=17' },
  { name: 'Section_XVIII.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=18' },
  { name: 'Section_XIX.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=19' },
  { name: 'Section_XX.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=20' },
  { name: 'Section_XXI.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?section=21' },
  { name: 'Supplement_2_מסקניה.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?type=supplement2' },
  { name: 'Supplement_3_WTO.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?type=supplement3' },
  { name: 'Discount_Codes.pdf', path: '/CustomspilotWeb/he/CustomsBook/Home/DownloadReport?type=discountcodes' },
];

// Main scanner function
async function runScanner() {
  console.log('🚀 Starting RPA-PORT Customs Scanner');
  console.log(`📅 Time: ${new Date().toISOString()}`);
  console.log('-----------------------------------');
  
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  
  // Try known PDF URLs
  for (const item of KNOWN_PDF_SECTIONS) {
    const fileName = item.name;
    const url = `${CUSTOMS_BASE_URL}${item.path}`;
    
    console.log(`\n📄 Processing: ${fileName}`);
    
    // Check if already exists
    const exists = await fileExists(fileName);
    if (exists) {
      console.log(`⏭️ Skipping (already exists): ${fileName}`);
      skipped++;
      continue;
    }
    
    // Download
    const fileBuffer = await downloadFile(url);
    if (!fileBuffer) {
      console.log(`❌ Failed to download: ${fileName}`);
      failed++;
      continue;
    }
    
    // Detect category and upload
    const { category } = detectCategory(fileName);
    const docId = await uploadToFirebase(fileName, fileBuffer, category);
    
    if (docId) {
      uploaded++;
    } else {
      failed++;
    }
    
    // Small delay between downloads
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('\n-----------------------------------');
  console.log('📊 SCAN COMPLETE');
  console.log(`✅ Uploaded: ${uploaded}`);
  console.log(`⏭️ Skipped (existing): ${skipped}`);
  console.log(`❌ Failed: ${failed}`);
  console.log('-----------------------------------');
  
  // Log to Firestore
  try {
    await addDoc(collection(db, 'scanner_logs'), {
      timestamp: serverTimestamp(),
      uploaded,
      skipped,
      failed,
      status: failed === 0 ? 'success' : 'partial'
    });
  } catch (e) {
    console.log('Could not save log to Firestore');
  }
}

// Run the scanner
runScanner()
  .then(() => {
    console.log('\n✅ Scanner finished');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Scanner error:', error);
    process.exit(1);
  });
