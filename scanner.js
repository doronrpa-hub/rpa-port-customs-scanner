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
  console.log('🚀 Starting RPA-PORT Customs Scanner v4');
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
  
  // Enable request interception
  await page.setRequestInterception(true);
  
  let capturedPdfBuffer = null;
  
  page.on('request', (request) => {
    request.continue();
  });
  
  page.on('response', async (response) => {
    try {
      const url = response.url();
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      const contentDisposition = headers['content-disposition'] || '';
