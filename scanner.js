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
  var path = 'documents/' + category + '/' + Date.now() + '_' + fileName;
  var storageRef = ref(storage, path);
  await uploadBytes(storageRef, buffer, { contentType: 'application/pdf' });
  var url = await getDownloadURL(storageRef);
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
  
  var browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  var page = await browser.newPage();
  var pdfBuffer = null;
  
  page.on('response', async function(res) {
    var ct = res.headers()['content-type'] || '';
    if (ct.includes('pdf') || ct.includes('octet')) {
      try {
        pdfBuffer = await res.buffer();
        console.log('Captured PDF: ' + pdfBuffer.length + ' bytes');
      } catch (e) {}
    }
  });
  
  var URL = 'https://shaarolami-query.customs.mof.gov.il/CustomspilotWeb/he/CustomsBook/Home/LinkReports';
  
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(function(r) { setTimeout(r, 3000); });
  
  var items = ['I', 'II', 'III', 'IV', 'V'];
  var uploaded = 0;
  
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    console.log('Processing: ' + item);
    pdfBuffer = null;
    
    await page.evaluate(function(t) {
      var spans = document.querySelectorAll('span');
      for (var j = 0; j < spans.length; j++) {
        if (spans[j].innerText.trim() === t) {
          spans[j].click();
        }
      }
    }, item);
    
    await new Promise(function(r) { setTimeout(r, 6000); });
    
    if (pdfBuffer && pdfBuffer.length > 5000) {
      await uploadToFirebase(pdfBuffer, 'Section_' + item + '.pdf', 'tariff');
      uploaded++;
    } else {
      console.log('No PDF for: ' + item);
    }
    
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(function(r) { setTimeout(r, 2000); });
  }
  
  await browser.close();
  console.log('Done. Uploaded: ' + uploaded);
}

run().then(function() {
  process.exit(0);
}).catch(function(e) {
  console.error(e);
  process.exit(1);
});
