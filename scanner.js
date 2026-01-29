const puppeteer = require('puppeteer');
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc, getDocs, query, where, serverTimestamp } = require('firebase/firestore');
const { getStorage, ref, uploadBytes, getDownloadURL } = require('firebase/storage');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Firebase Config
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

const DOWNLOAD_DIR = path.join(process.cwd(), 'downloads');
const CUSTOMS_BASE = 'https://shaarolami-query.customs.mof.gov.il';
const LINK_REPORTS_URL = `${CUSTOMS_BASE}/CustomspilotWeb/he/CustomsBook/Home/LinkReports`;

function detectCategory(fileName) {
  const name = fileName.toLowerCase();
  if (name.includes('תוספת') || name.includes('supplement') || name.includes('wto')) return 'supplement';
  if (name.includes('נוהל') || name.includes('פקודה')) return 'procedure';
  if (name.includes('הסכם') || name.includes('agreement')) return 'agreement';
  return 'tariff';
}

async function fileExists(fileName) {
  try {
    const q = query(collection(db, 'files'), where('name', '==', fileName));
    const snapshot = await getDocs(q);
    return !snapshot.empty;
  } catch (error) {
    return false;
  }
}

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/pdf,*/*'
      }
    }, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        downloadFile(response.headers.location).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

async function uploadToFirebase(fileBuffer, fileName) {
  try {
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

async function runScanner() {
  console.log('🚀 Starting RPA-PORT Customs Scanner v3');
  console.log(`📅 Time: ${new Date().toISOString()}`);
  console.log('-----------------------------------');
  
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
  
  console.log('🌐 Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  // Track PDF URLs from network requests
  const pdfUrls = [];
  
  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';
    
    if (contentType.includes('pdf') || url.includes('.pdf') || url.includes('Download') || url.includes('Report')) {
      console.log(`🔗 Detected URL: ${url}`);
      pdfUrls.push(url);
    }
  });
  
  // Also track new pages/tabs that open
  browser.on('targetcreated', async (target) => {
    const url = target.url();
    if (url && url !== 'about:blank') {
      console.log(`🔗 New tab URL: ${url}`);
      pdfUrls.push(url);
    }
  });
  
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  
  // Items to download
  const itemsToDownload = [
    'הורדת קובץ התעריף',
    'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
    'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI', 'XXII',
    'קודי הנחה', 'צו מסגרת',
    'תוספת שניה', 'תוספת שלישית WTO', 'תוספת רביעית', 'תוספת חמישית',
    'תוספת שישית', 'תוספת שביעית', 'תוספת שמינית', 'תוספת תשיעית',
    'תוספת עשירית', 'תוספת ארבע עשר', 'תוספת חמש עשר', 'תוספת שש עשר', 'תוספת שבע עשר'
  ];
  
  try {
    console.log('📄 Loading customs tariff page...');
    await page.goto(LINK_REPORTS_URL, { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    for (const itemName of itemsToDownload) {
      const fileName = `${itemName.replace(/[^a-zA-Z0-9א-ת\s]/g, '').trim()}.pdf`;
      console.log(`\n📄 Processing: "${itemName}"`);
      
      const exists = await fileExists(fileName);
      if (exists) {
        console.log(`⏭️ Skipping (exists): ${fileName}`);
        skipped++;
        continue;
      }
      
      try {
        // Clear tracked URLs
        pdfUrls.length = 0;
        
        // Find and click the element
        const clicked = await page.evaluate((text) => {
          const elements = document.querySelectorAll('span, a, li, div');
          for (const el of elements) {
            if (el.innerText?.trim() === text) {
              el.click();
              return true;
            }
          }
          return false;
        }, itemName);
        
        if (!clicked) {
          console.log(`⚠️ Element not found: "${itemName}"`);
          failed++;
          continue;
        }
        
        console.log(`🖱️ Clicked: "${itemName}"`);
        
        // Wait for response
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Check if we got any PDF URLs
        if (pdfUrls.length > 0) {
          const pdfUrl = pdfUrls[pdfUrls.length - 1];
          console.log(`📥 Downloading from: ${pdfUrl}`);
          
          try {
            const fileBuffer = await downloadFile(pdfUrl);
            if (fileBuffer && fileBuffer.length > 1000) {
              const success = await uploadToFirebase(fileBuffer, fileName);
              if (success) uploaded++;
              else failed++;
            } else {
              console.log(`⚠️ Downloaded file too small or empty`);
              failed++;
            }
          } catch (dlError) {
            console.log(`⚠️ Download failed: ${dlError.message}`);
            failed++;
          }
        } else {
          // Try to get URL from any new pages
          const pages = await browser.pages();
          for (const p of pages) {
            const url = p.url();
            if (url !== LINK_REPORTS_URL && url !== 'about:blank') {
              console.log(`📥 Found new page: ${url}`);
              
              try {
                const fileBuffer = await downloadFile(url);
                if (fileBuffer && fileBuffer.length > 1000) {
                  const success = await uploadToFirebase(fileBuffer, fileName);
                  if (success) uploaded++;
                  else failed++;
                  await p.close();
                  break;
                }
              } catch (e) {
                console.log(`⚠️ Could not download from new page`);
              }
            }
          }
          
          if (pdfUrls.length === 0) {
            console.log(`⚠️ No PDF URL detected for: "${itemName}"`);
            failed++;
          }
        }
        
        // Go back to main page if needed
        if (page.url() !== LINK_REPORTS_URL) {
          await page.goto(LINK_REPORTS_URL, { waitUntil: 'networkidle0', timeout: 60000 });
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
      } catch (error) {
        console.error(`❌ Error processing "${itemName}": ${error.message}`);
        failed++;
        
        // Try to recover
        try {
          await page.goto(LINK_REPORTS_URL, { waitUntil: 'networkidle0', timeout: 6000
