const puppeteer = require('puppeteer');
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc, serverTimestamp } = require('firebase/firestore');
const { getStorage, ref, uploadBytes, getDownloadURL } = require('firebase/storage');

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

async function uploadToFirebase(buffer, fileName, category) {
  const path = 'documents/' + category + '/' + Date.now() + '_' + fileName;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, buffer, { contentType: 'application/pdf' });
  const url = await getDownloadURL(storageRef);
  await addDoc(collection(db, 'files'), {
    name: fileName,
    size: buffer.length,
    type: 'application/pdf',
    category: category,
    url: url,
    path: path,
    uploadedAt: serverTimestamp(),
    source: 'auto-scanner'
  });
  console.log('Uploaded: ' + fileName);
  return true;
}

async function run() {
  console.log('Starting scanner...');
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  
  let pdfBuffer = null;
  
  page.on('response', async (res) => {
    const ct = res.headers()['content-type'] || '';
    if (ct.includes('pdf') || ct.includes('octet')) {
      try {
        pdfBuffer = await res.buffer();
        console.log('Captured PDF: ' + pdfBuffer.length + ' bytes');
      } catch (e) {}
    }
  });
  
  const URL = 'https://shaarolami-query.customs.mof.gov.il/CustomspilotWeb/he/CustomsBook/Home/LinkReports';
  
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000
