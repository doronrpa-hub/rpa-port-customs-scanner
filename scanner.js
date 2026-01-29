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

async function waitForDownload(directory, timeout = 60000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const files = fs.readdirSync(directory);
    const pdfFile = files.find(f => f.endsWith('.pdf') && !f.endsWith('.crdownload'));
    if (pdfFile) return pdfFile;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return null;
}

async function runScanner() {
  console.log('🚀 Starting RPA-PORT Customs Scanner v2');
  console.log(`📅 Time: ${new Date().toISOString()}`);
  console.log('-----------------------------------');
  
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
  
  // Clear download directory
  const existingFiles = fs.readdirSync(DOWNLOAD_DIR);
  existingFiles.forEach(f => fs.unlinkSync(path.join(DOWNLOAD_DIR, f)));
  
  console.log('🌐 Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  const page = await browser.newPage();
  
  // Set download behavior
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_DIR
  });
  
  // Set viewport and user agent
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  
  try {
    console.log('📄 Loading customs tariff page...');
    await page.goto(LINK_REPORTS_URL, { waitUntil: 'networkidle0', timeout: 60000 });
    
    // Wait for dynamic content
    console.log('⏳ Waiting for dynamic content...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Take screenshot for debugging
    await page.screenshot({ path: path.join(DOWNLOAD_DIR, 'page.png'), fullPage: true });
    console.log('📸 Screenshot saved');
    
    // Get page HTML for debugging
    const pageContent = await page.content();
    console.log(`📝 Page content length: ${pageContent.length} chars`);
    
    // Find all clickable elements with download-related text
    const downloadButtons = await page.evaluate(() => {
      const results = [];
      
      // Find all links and buttons
      const elements = document.querySelectorAll('a, button, li, span, div');
      
      elements.forEach((el, index) => {
        const text = el.innerText?.trim() || '';
        const onclick = el.getAttribute('onclick') || '';
        const href = el.getAttribute('href') || '';
        const className = el.className || '';
        
        // Match Roman numerals, Hebrew supplement names, etc.
        const isDownloadLink = 
          /^I{1,3}$|^IV$|^V$|^VI{1,3}$|^IX$|^X{1,3}$|^XI{1,3}$|^XIV$|^XV$|^XVI{1,3}$|^XIX$|^XX{1,2}$|^XXI{1,2}$/.test(text) ||
          text.includes('תוספת') ||
          text.includes('קודי הנחה') ||
          text.includes('צו מסגרת') ||
          text.includes('הורדת קובץ') ||
          onclick.includes('Download') ||
          href.includes('Download');
        
        if (isDownloadLink && text.length > 0 && text.length < 50) {
          results.push({
            text: text,
            tagName: el.tagName,
            index: index,
            hasOnclick: onclick.length > 0,
            hasHref: href.length > 0
          });
        }
      });
      
      return results;
    });
    
    console.log(`📋 Found ${downloadButtons.length} potential download elements:`);
    downloadButtons.forEach(btn => console.log(`   - "${btn.text}" (${btn.tagName})`));
    
    if (downloadButtons.length === 0) {
      // Log all text on page for debugging
      const allText = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('li, a')).map(el => el.innerText?.trim()).filter(t => t && t.length < 100);
      });
      console.log('📝 Page elements found:', allText.slice(0, 30));
    }
    
    // Process each download button
    for (const btn of downloadButtons) {
      const fileName = `${btn.text.replace(/[^a-zA-Z0-9א-ת\s]/g, '').trim()}.pdf`;
      console.log(`\n📄 Processing: "${btn.text}" -> ${fileName}`);
      
      const exists = await fileExists(fileName);
      if (exists) {
        console.log(`⏭️ Skipping (exists): ${fileName}`);
        skipped++;
        continue;
      }
      
      try {
        // Find and click the element
        const elements = await page.$$('a, button, li, span');
        let clicked = false;
        
        for (const element of elements) {
          const text = await element.evaluate(el => el.innerText?.trim());
          if (text === btn.text) {
            await element.click();
            clicked = true;
            console.log(`🖱️ Clicked: "${btn.text}"`);
            break;
          }
        }
        
        if (!clicked) {
          console.log(`⚠️ Could not find element to click: "${btn.text}"`);
          failed++;
          continue;
        }
        
        // Wait for download
        console.log('⏳ Waiting for download...');
        const downloadedFile = await waitForDownload(DOWNLOAD_DIR, 30000);
        
        if (downloadedFile) {
          const filePath = path.join(DOWNLOAD_DIR, downloadedFile);
          const success = await uploadToFirebase(filePath, fileName);
          
          if (success) {
            uploaded++;
          } else {
            failed++;
          }
          
          // Clean up
          try { fs.unlinkSync(filePath); } catch (e) {}
        } else {
          console.log(`⚠️ No download received for: "${btn.text}"`);
          failed++;
        }
        
      } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        failed++;
      }
      
      // Small delay
      await new Promise(resolve => setTimeout(resolve, 2000));
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
  
  try {
    await addDoc(collection(db, 'scanner_logs'), {
      timestamp: serverTimestamp(),
      uploaded, skipped, failed
    });
  } catch (e) {}
}

runScanner()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
