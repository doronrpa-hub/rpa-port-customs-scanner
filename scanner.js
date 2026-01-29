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
const LINK_REPORTS_URL = CUSTOMS_BASE + '/CustomspilotWeb/he/CustomsBook/Home/LinkReports';

function detectCategory(fileName) {
  const name = fileName.toLowerCase();
  if (name.includes('תוספת') || name.includes('wto')) return 'supplement';
  if (name.includes('נוהל') || name.includes('פקודה')) return 'procedure';
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
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/pdf,*/*'
      },
      timeout: 60000
    };
    
    protocol.get(url, options, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        downloadFile(response.headers.location).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error('HTTP ' + response.statusCode));
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
    const storagePath = 'documents/' + category + '/' + timestamp + '_' + fileName;
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
    
    console.log('✅ Uploaded: ' + fileName + ' (' + (fileBuffer.length / 1024 / 1024).toFixed(2) + ' MB)');
    return true;
  } catch (error) {
    console.error('❌ Upload error: ' + error.message);
    return false;
  }
}

async function runScanner() {
  console.log('🚀 Starting RPA-PORT Customs Scanner v3');
  console.log('📅 Time: ' + new Date().toISOString());
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
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  
  let pdfUrls = [];
  
  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';
    if (contentType.includes('pdf') || url.includes('.pdf') || url.includes('Download')) {
      console.log('🔗 Detected: ' + url);
      pdfUrls.push(url);
    }
  });
  
  browser.on('targetcreated', async (target) => {
    const url = target.url();
    if (url && url !== 'about:blank' && !url.includes('LinkReports')) {
      console.log('🔗 New tab: ' + url);
      pdfUrls.push(url);
    }
  });
  
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  
  const items = [
    'הורדת קובץ התעריף',
    'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
    'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI', 'XXII',
    'קודי הנחה', 'צו מסגרת',
    'תוספת שניה', 'תוספת שלישית WTO', 'תוספת רביעית', 'תוספת חמישית',
    'תוספת שישית', 'תוספת שביעית', 'תוספת שמינית', 'תוספת תשיעית',
    'תוספת עשירית', 'תוספת ארבע עשר', 'תוספת חמש עשר', 'תוספת שש עשר', 'תוספת שבע עשר'
  ];
  
  try {
    console.log('📄 Loading page...');
    await page.goto(LINK_REPORTS_URL, { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
    
    for (const itemName of items) {
      const fileName = itemName.replace(/[^a-zA-Z0-9א-ת\s]/g, '').trim() + '.pdf';
      console.log('\n📄 Processing: ' + itemName);
      
      const exists = await fileExists(fileName);
      if (exists) {
        console.log('⏭️ Skipping (exists): ' + fileName);
        skipped++;
        continue;
      }
      
      pdfUrls = [];
      
      try {
        const clicked = await page.evaluate((text) => {
          const els = document.querySelectorAll('span, a, li, div');
          for (const el of els) {
            if (el.innerText && el.innerText.trim() === text) {
              el.click();
              return true;
            }
          }
          return false;
        }, itemName);
        
        if (!clicked) {
          console.log('⚠️ Not found: ' + itemName);
          failed++;
          continue;
        }
        
        console.log('🖱️ Clicked: ' + itemName);
        await new Promise(r => setTimeout(r, 5000));
        
        if (pdfUrls.length > 0) {
          const pdfUrl = pdfUrls[pdfUrls.length - 1];
          console.log('📥 Downloading: ' + pdfUrl);
          
          const fileBuffer = await downloadFile(pdfUrl);
          if (fileBuffer && fileBuffer.length > 1000) {
            const success = await uploadToFirebase(fileBuffer, fileName);
            if (success) uploaded++;
            else failed++;
          } else {
            console.log('⚠️ File too small');
            failed++;
          }
        } else {
          const pages = await browser.pages();
          let found = false;
          for (const p of pages) {
            const pUrl = p.url();
            if (pUrl !== LINK_REPORTS_URL && pUrl !== 'about:blank') {
              console.log('📥 From new tab: ' + pUrl);
              try {
                const buf = await downloadFile(pUrl);
                if (buf && buf.length > 1000) {
                  const success = await uploadToFirebase(buf, fileName);
                  if (success) uploaded++;
                  else failed++;
                  found = true;
                  await p.close();
                  break;
                }
              } catch (e) {}
            }
          }
          if (!found) {
            console.log('⚠️ No PDF found for: ' + itemName);
            failed++;
          }
        }
        
        if (page.url() !== LINK_REPORTS_URL) {
          await page.goto(LINK_REPORTS_URL, { waitUntil: 'networkidle0', timeout: 60000 });
          await new Promise(r => setTimeout(r, 2000));
        }
        
      } catch (err) {
        console.error('❌ Error: ' + err.message);
        failed++;
        try {
          await page.goto(LINK_REPORTS_URL, { waitUntil: 'networkidle0', timeout: 60000 });
        } catch (e) {}
      }
      
      await new Promise(r => setTimeout(r, 1000));
    }
    
  } catch (error) {
    console.error('❌ Scanner error: ' + error.message);
  } finally {
    await browser.close();
  }
  
  console.log('\n-----------------------------------');
  console.log('📊 SCAN COMPLETE');
  console.log('✅ Uploaded: ' + uploaded);
  console.log('⏭️ Skipped: ' + skipped);
  console.log('❌ Failed: ' + failed);
  console.log('-----------------------------------');
  
  try {
    await addDoc(collection(db, 'scanner_logs'), {
      timestamp: serverTimestamp(),
      uploaded: uploaded,
      skipped: skipped,
      failed: failed
    });
  } catch (e) {}
}

runScanner()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
