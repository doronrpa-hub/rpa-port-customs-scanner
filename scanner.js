const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc, getDocs, query, where, serverTimestamp, doc, setDoc } = require('firebase/firestore');
const https = require('https');

// Firebase Config
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Base URL for customs API
const BASE_URL = 'https://shaarolami-query.customs.mof.gov.il';

// Fetch URL content
function fetchUrl(url) {
  return new Promise(function(resolve, reject) {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8'
      }
    }, function(response) {
      var data = '';
      response.on('data', function(chunk) { data += chunk; });
      response.on('end', function() { resolve(data); });
      response.on('error', reject);
    }).on('error', reject);
  });
}

// Parse HS codes from HTML
function parseHSCodes(html, chapterId) {
  var items = [];
  
  // Match HS code patterns (10 digits)
  var hsPattern = /(\d{10})\/?\d?/g;
  var matches = html.match(hsPattern) || [];
  
  // Get unique codes
  var seen = {};
  matches.forEach(function(code) {
    var clean = code.replace(/\/\d$/, '');
    if (!seen[clean] && clean.length === 10) {
      seen[clean] = true;
    }
  });
  
  return Object.keys(seen);
}

// Extract text content between tags
function extractText(html) {
  // Remove scripts and styles
  var clean = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  clean = clean.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // Remove HTML tags
  clean = clean.replace(/<[^>]+>/g, ' ');
  // Clean whitespace
  clean = clean.replace(/\s+/g, ' ').trim();
  return clean;
}

// Save chapter data to Firestore
async function saveChapterData(chapterId, chapterName, content, hsCodes, source) {
  try {
    var docId = source + '_chapter_' + String(chapterId).padStart(2, '0');
    
    await setDoc(doc(db, 'tariff_chapters', docId), {
      chapterId: chapterId,
      chapterName: chapterName,
      source: source,
      content: content.substring(0, 900000), // Firestore limit
      hsCodes: hsCodes,
      hsCodeCount: hsCodes.length,
      updatedAt: serverTimestamp(),
      scannedAt: new Date().toISOString()
    });
    
    console.log('Saved: ' + docId + ' (' + hsCodes.length + ' HS codes)');
    return true;
  } catch (error) {
    console.error('Error saving ' + chapterId + ': ' + error.message);
    return false;
  }
}

// Save individual HS code
async function saveHSCode(hsCode, description, chapterId, source) {
  try {
    await setDoc(doc(db, 'hs_codes', hsCode), {
      hsCode: hsCode,
      description: description,
      chapterId: chapterId,
      source: source,
      updatedAt: serverTimestamp()
    });
    return true;
  } catch (error) {
    return false;
  }
}

// Scan Import Tariff
async function scanImportTariff() {
  console.log('\n📦 Scanning IMPORT Tariff...');
  
  // Known chapter IDs from the customs system
  // These IDs correspond to the 21 sections and chapters within them
  var chapterIds = [
    // Section I - Live animals (Ch 01-05)
    1, 2, 3, 4, 5,
    // Section II - Vegetable products (Ch 06-14)
    1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009,
    // Section III - Fats (Ch 15)
    2001,
    // Section IV - Food (Ch 16-24)
    3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009,
    // Section V - Mineral (Ch 25-27)
    4001, 4002, 4003,
    // Section VI - Chemical (Ch 28-38)
    5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5009, 5010, 5011,
    // And more sections...
    15982, 16904, 18359, 25355, 8901, 10937, 3953 // Known working IDs
  ];
  
  var saved = 0;
  var failed = 0;
  
  for (var i = 0; i < chapterIds.length; i++) {
    var id = chapterIds[i];
    var url = BASE_URL + '/CustomspilotWeb/he/CustomsBook/Import/ImportCustomsItemDetails?customsItemId=' + id;
    
    console.log('Fetching ID: ' + id);
    
    try {
      var html = await fetchUrl(url);
      
      if (html.length < 1000) {
        console.log('  Empty response, skipping');
        continue;
      }
      
      var hsCodes = parseHSCodes(html, id);
      var content = extractText(html);
      
      // Extract chapter name from content
      var chapterMatch = content.match(/פרק\s+(\d+)\s*-\s*([^;]+)/);
      var chapterName = chapterMatch ? chapterMatch[0] : 'Chapter ' + id;
      
      if (hsCodes.length > 0 || content.length > 5000) {
        await saveChapterData(id, chapterName, content, hsCodes, 'import');
        saved++;
      }
      
      // Small delay
      await new Promise(function(r) { setTimeout(r, 500); });
      
    } catch (error) {
      console.log('  Error: ' + error.message);
      failed++;
    }
  }
  
  console.log('Import scan complete: ' + saved + ' saved, ' + failed + ' failed');
  return saved;
}

// Scan by searching each 2-digit chapter
async function scanByChapter() {
  console.log('\n📋 Scanning by Chapter (01-99)...');
  
  var saved = 0;
  
  for (var ch = 1; ch <= 99; ch++) {
    var chapterNum = String(ch).padStart(2, '0');
    var searchUrl = BASE_URL + '/CustomspilotWeb/he/CustomsBook/Import/CustomsTaarifEntry';
    
    // We'll try direct chapter URLs
    var url = BASE_URL + '/CustomspilotWeb/he/CustomsBook/Import/ImportCustomsItemDetails?customsItemId=' + (ch * 100);
    
    console.log('Chapter ' + chapterNum + '...');
    
    try {
      var html = await fetchUrl(url);
      var hsCodes = parseHSCodes(html, ch);
      var content = extractText(html);
      
      if (content.length > 2000) {
        await saveChapterData(ch, 'פרק ' + chapterNum, content, hsCodes, 'import');
        saved++;
      }
      
      await new Promise(function(r) { setTimeout(r, 300); });
      
    } catch (error) {
      console.log('  Skip: ' + error.message);
    }
  }
  
  return saved;
}

// Scan Export Tariff
async function scanExportTariff() {
  console.log('\n📤 Scanning EXPORT Tariff...');
  
  var url = BASE_URL + '/CustomspilotWeb/he/CustomsBook/Export/ExportCustomsEntry';
  
  try {
    var html = await fetchUrl(url);
    var content = extractText(html);
    
    await setDoc(doc(db, 'tariff_chapters', 'export_main'), {
      source: 'export',
      content: content.substring(0, 900000),
      updatedAt: serverTimestamp()
    });
    
    console.log('Export tariff saved');
    return 1;
  } catch (error) {
    console.log('Export error: ' + error.message);
    return 0;
  }
}

// Scan Autonomy
async function scanAutonomy() {
  console.log('\n🔄 Scanning AUTONOMY...');
  
  var url = BASE_URL + '/CustomspilotWeb/he/CustomsBook/Autonomy/AutonomyCustomsEntry';
  
  try {
    var html = await fetchUrl(url);
    var content = extractText(html);
    
    await setDoc(doc(db, 'tariff_chapters', 'autonomy_main'), {
      source: 'autonomy',
      content: content.substring(0, 900000),
      updatedAt: serverTimestamp()
    });
    
    console.log('Autonomy tariff saved');
    return 1;
  } catch (error) {
    console.log('Autonomy error: ' + error.message);
    return 0;
  }
}

// Scan specific known pages with full data
async function scanKnownPages() {
  console.log('\n📑 Scanning known data pages...');
  
  var pages = [
    { id: 15982, name: 'פרק 20 - תכשירים מירקות ופירות' },
    { id: 16904, name: 'חלק IV - תכשירי מזון' },
    { id: 18359, name: 'פרק 87 - רכב' },
    { id: 8901, name: 'פרק 85 - חשמל' }
  ];
  
  var saved = 0;
  
  for (var i = 0; i < pages.length; i++) {
    var page = pages[i];
    var url = BASE_URL + '/CustomspilotWeb/he/CustomsBook/Import/ImportCustomsItemDetails?customsItemId=' + page.id;
    
    console.log('Fetching: ' + page.name);
    
    try {
      var html = await fetchUrl(url);
      var hsCodes = parseHSCodes(html, page.id);
      var content = extractText(html);
      
      await saveChapterData(page.id, page.name, content, hsCodes, 'import');
      saved++;
      
      await new Promise(function(r) { setTimeout(r, 500); });
      
    } catch (error) {
      console.log('  Error: ' + error.message);
    }
  }
  
  return saved;
}

// Main function
async function main() {
  console.log('==========================================');
  console.log('🚀 RPA-PORT Customs API Scanner');
  console.log('📅 ' + new Date().toISOString());
  console.log('==========================================');
  
  var totalSaved = 0;
  
  // Scan known pages with full data
  totalSaved += await scanKnownPages();
  
  // Scan import tariff
  totalSaved += await scanImportTariff();
  
  // Scan export
  totalSaved += await scanExportTariff();
  
  // Scan autonomy
  totalSaved += await scanAutonomy();
  
  // Log results
  console.log('\n==========================================');
  console.log('📊 SCAN COMPLETE');
  console.log('✅ Total saved: ' + totalSaved);
  console.log('==========================================');
  
  // Save scan log
  try {
    await addDoc(collection(db, 'scanner_logs'), {
      timestamp: serverTimestamp(),
      type: 'api_scan',
      totalSaved: totalSaved,
      status: 'complete'
    });
  } catch (e) {}
}

main().then(function() {
  console.log('\n✅ Done');
  process.exit(0);
}).catch(function(e) {
  console.error('❌ Error:', e);
  process.exit(1);
});
