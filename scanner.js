const puppeteer = require('puppeteer');
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc, getDocs, query, where, serverTimestamp } = require('firebase/firestore');
const { getStorage, ref, uploadBytes, getDownloadURL } = require('firebase/storage');
const fs = require('fs');
const path = require('path');

// Firebase Config
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

// Download directory
const DOWNLOAD_DIR = path.join(process.cwd(), 'downloads');

// Customs URLs
const CUSTOMS_BASE = 'https://shaarolami-query.customs.mof.gov.il';
const LINK_REPORTS_URL = `${CUSTOMS_BASE}/CustomspilotWeb/he/CustomsBook/Home/LinkReports`;

// Category detection
function detectCategory(fileName) {
  const name = fileName.toLowerCase();
  if (name.includes('תוספת') || name.includes('supplement') || name.includes('wto')) {
    return 'supplement';
  }
  if (name.includes('נוהל') || name.includes('פקודה') || name.includes('הוראה')) {
    return 'procedure';
  }
  if (name.includes('הסכם') || name.includes('agreement')) {
    return 'agreement';
  }
  return 'tariff';
}

// Check if file exists in Firebase
async function fileExists(fileName) {
  try {
    const q = query(collection(db, 'files'), where('name', '==', fileName));
    const snapshot = await getDocs(q);
    return !snapshot.empty;
  } catch (error) {
    return false;
  }
}

// Upload to Firebase
async function uploadToFirebase(filePath, fileName) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const category = detectCategory(fileName);
    const timestamp = Date.now();
    const storagePath = `documents/${category}/${timestamp}_${fileName}`;
    const storageRef = ref(storage, storagePath);
    
    await uploadBytes(storageRef, fileBuffer, { contentType: 'application/pdf' });
    const downloadURL = await getDownloadURL(storageRef);
    
    await addDoc(collection(db, 'files'), {
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
    return true;
  } catch (error) {
    console.error(`❌ Upload error for ${fileName}:`, error.message);
    return false;
  }
}

// Main scanner
async function runScanner() {
  console.log('🚀 Starting RPA-PORT Customs Scanner (Puppeteer)');
  console.log(`📅 Time: ${new Date().toISOString()}`);
  console.log('-----------------------------------');
  
  // Create download directory
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
  
  // Launch browser
  console.log('🌐 Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  
  // Set download behavior
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_DIR
  });
  
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  
  try {
    // Go to LinkReports page
    console.log('📄 Loading customs tariff page...');
    await page.goto(LINK_REPORTS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Wait for page to load
    await page.waitForSelector('a', { timeout: 30000 });
    
    // Get all download links
    const links = await page.evaluate(() => {
      const anchors = document.querySelectorAll('a');
      const downloadLinks = [];
      anchors.forEach((a, index) => {
        const text = a.innerText.trim();
        const href = a.href;
        if (text && href && (href.includes('Download') || href.includes('Report') || text.match(/^[IVX]+$|תוספת|קודי|צו/))) {
          downloadLinks.push({ text, href, index });
        }
      });
      return downloadLinks;
    });
    
    console.log(`📋 Found ${links.length} download links`);
    
    // Process each link
    for (const link of links) {
      const fileName = `${link.text.replace(/[^a-zA-Z0-9א-ת]/g, '_')}.pdf`;
      console.log(`\n📄 Processing: ${fileName}`);
      
      // Check if exists
      const exists = await fileExists(fileName);
      if (exists) {
        console.log(`⏭️ Skipping (exists): ${fileName}`);
        skipped++;
        continue;
      }
      
      try {
        // Click download link
        const linkElement = await page.$(`a[href="${link.href}"]`);
        if (linkElement) {
          await linkElement.click();
          
          // Wait for download
          await new Promise(resolve => setTimeout(resolve, 10000));
          
          // Find downloaded file
          const files = fs.readdirSync(DOWNLOAD_DIR);
          const newFile = files.find(f => f.endsWith('.pdf'));
          
          if (newFile) {
            const filePath = path.join(DOWNLOAD_DIR, newFile);
            const success = await uploadToFirebase(filePath, fileName);
            
            if (success) {
              uploaded++;
              fs.unlinkSync(filePath); // Clean up
            } else {
              failed++;
            }
          } else {
            console.log(`⚠️ No PDF downloaded for: ${link.text}`);
            failed++;
          }
        }
      } catch (error) {
        console.error(`❌ Error processing ${link.text}:`, error.message);
        failed++;
      }
      
      // Delay between downloads
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
  } catch (error) {
    console.error('❌ Scanner error:', error.message);
  } finally {
    await browser.close();
  }
  
  console.log('\n-----------------------------------');
  console.log('📊 SCAN COMPLETE');
  console.log(`✅ Uploaded: ${uploaded}`);
  console.log(`⏭️ Skipped: ${skipped}`);
  console.log(`❌ Failed: ${failed}`);
  console.log('-----------------------------------');
  
  // Log to Firestore
  try {
    await addDoc(collection(db, 'scanner_logs'), {
      timestamp: serverTimestamp(),
      uploaded,
      skipped,
      failed
    });
  } catch (e) {}
}

runScanner()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
