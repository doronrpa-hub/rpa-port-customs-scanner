// RPA-PORT Customs Scanner v3.0
// Scans ALL chapters 1-99 with all subheadings
// Also scans Export and Autonomy tariffs

const https = require('https');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, collection, serverTimestamp } = require('firebase/firestore');

// Firebase config
const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Stats
let stats = { saved: 0, failed: 0, hsCodesTotal: 0 };

// HTTPS GET with Hebrew support
function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        };
        
        https.get(url, options, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, data }));
            res.on('error', reject);
        }).on('error', reject);
    });
}

// Extract HS codes (10-digit patterns)
function parseHSCodes(html) {
    const codes = new Set();
    // Match 10-digit codes with possible dots/dashes
    const patterns = [
        /\b(\d{4})[.\-\s]?(\d{2})[.\-\s]?(\d{2})[.\-\s]?(\d{2})\b/g,
        /\b(\d{10})\b/g
    ];
    
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(html)) !== null) {
            const code = match[0].replace(/[.\-\s]/g, '');
            if (code.length === 10 && /^\d+$/.test(code)) {
                codes.add(code);
            }
        }
    }
    return Array.from(codes);
}

// Clean HTML to text
function extractText(html) {
    return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (m, c) => String.fromCharCode(c))
        .replace(/\s+/g, ' ')
        .trim();
}

// Extract chapter name from HTML
function extractChapterName(html) {
    // Try to find Hebrew chapter name
    const patterns = [
        /<h1[^>]*>([^<]+)<\/h1>/i,
        /<h2[^>]*>([^<]+)<\/h2>/i,
        /פרק\s*(\d+)[:\-\s]*([^\n<]+)/,
        /חלק\s*([IVX]+)[:\-\s]*([^\n<]+)/i
    ];
    
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
            return extractText(match[0]).substring(0, 200);
        }
    }
    return null;
}

// Save chapter to Firestore
async function saveChapter(id, name, content, hsCodes, source) {
    try {
        const docId = `${source}_chapter_${id}`;
        await setDoc(doc(db, 'tariff_chapters', docId), {
            chapterId: id,
            chapterName: name || `Chapter ${id}`,
            source: source,
            content: content.substring(0, 900000), // Firestore limit
            hsCodes: hsCodes.slice(0, 1000),
            hsCodeCount: hsCodes.length,
            updatedAt: new Date().toISOString(),
            scannedAt: new Date().toISOString()
        });
        
        stats.saved++;
        stats.hsCodesTotal += hsCodes.length;
        console.log(`✅ Saved: ${docId} (${hsCodes.length} HS codes)`);
        return true;
    } catch (error) {
        console.log(`❌ Failed: ${id} - ${error.message}`);
        stats.failed++;
        return false;
    }
}

// Fetch and save a single page by customsItemId
async function fetchAndSavePage(itemId, source = 'import') {
    const url = `https://shaarolami-query.customs.mof.gov.il/CustomspilotWeb/he/CustomsBook/Import/ImportCustomsItemDetails?customsItemId=${itemId}`;
    
    try {
        const response = await fetchUrl(url);
        
        if (response.status !== 200 || response.data.length < 1000) {
            return false;
        }
        
        const text = extractText(response.data);
        const hsCodes = parseHSCodes(response.data);
        const name = extractChapterName(response.data);
        
        if (text.length > 500) {
            await saveChapter(itemId, name, text, hsCodes, source);
            return true;
        }
        return false;
    } catch (error) {
        return false;
    }
}

// Discover all chapter IDs from the main tariff index
async function discoverChapterIds() {
    console.log('\n🔍 Discovering all chapter IDs from tariff index...');
    
    const allIds = new Set();
    
    // Try the main tariff book pages
    const indexUrls = [
        'https://shaarolami-query.customs.mof.gov.il/CustomspilotWeb/he/CustomsBook/Import/CustomsTaarifEntry',
        'https://shaarolami-query.customs.mof.gov.il/CustomspilotWeb/he/CustomsBook'
    ];
    
    for (const url of indexUrls) {
        try {
            console.log(`Checking: ${url}`);
            const response = await fetchUrl(url);
            
            // Find all customsItemId values in the page
            const idPatterns = [
                /customsItemId[=:](\d+)/gi,
                /ImportCustomsItemDetails\?customsItemId=(\d+)/gi,
                /href="[^"]*customsItemId=(\d+)[^"]*"/gi,
                /"id"\s*:\s*(\d+)/g
            ];
            
            for (const pattern of idPatterns) {
                let match;
                while ((match = pattern.exec(response.data)) !== null) {
                    const id = parseInt(match[1]);
                    if (id > 0 && id < 100000) {
                        allIds.add(id);
                    }
                }
            }
        } catch (error) {
            console.log(`Could not fetch: ${url}`);
        }
    }
    
    console.log(`Found ${allIds.size} potential chapter IDs from index`);
    return Array.from(allIds).sort((a, b) => a - b);
}

// Comprehensive ID scan - covers known patterns
function generateAllPossibleIds() {
    const ids = new Set();
    
    // Pattern 1: Direct chapter numbers (1-99)
    for (let i = 1; i <= 99; i++) {
        ids.add(i);
    }
    
    // Pattern 2: 1000s (chapter 01 subheadings)
    for (let i = 1001; i <= 1099; i++) ids.add(i);
    
    // Pattern 3: 2000s (chapter 02 subheadings)
    for (let i = 2001; i <= 2099; i++) ids.add(i);
    
    // Pattern 4: 3000s (chapter 03 subheadings)
    for (let i = 3001; i <= 3099; i++) ids.add(i);
    
    // Pattern 5: 4000s-9000s
    for (let base = 4000; base <= 9000; base += 1000) {
        for (let i = 1; i <= 99; i++) {
            ids.add(base + i);
        }
    }
    
    // Pattern 6: 10000s-30000s (these are where many chapters are)
    for (let base = 10000; base <= 30000; base += 1000) {
        for (let i = 0; i <= 99; i++) {
            ids.add(base + i);
        }
    }
    
    // Known working IDs
    const knownIds = [
        15982, 16904, 18359, 25355, 8901, 10937, 3953,
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
        1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010,
        2001, 2002, 2003, 2004, 2005,
        3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009,
        4001, 4002, 4003, 4004, 4005,
        5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5009, 5010, 5011
    ];
    
    knownIds.forEach(id => ids.add(id));
    
    return Array.from(ids).sort((a, b) => a - b);
}

// Main scan function
async function scanImportTariff() {
    console.log('\n📦 Scanning IMPORT Tariff...\n');
    
    // First try to discover IDs from the index
    const discoveredIds = await discoverChapterIds();
    
    // Generate all possible IDs
    const allIds = generateAllPossibleIds();
    
    // Combine discovered and generated IDs
    const idsToScan = [...new Set([...discoveredIds, ...allIds])].sort((a, b) => a - b);
    
    console.log(`\n📋 Will scan ${idsToScan.length} potential chapter IDs...\n`);
    
    let scanned = 0;
    let found = 0;
    
    for (const id of idsToScan) {
        scanned++;
        
        // Progress update every 100
        if (scanned % 100 === 0) {
            console.log(`Progress: ${scanned}/${idsToScan.length} scanned, ${found} found`);
        }
        
        const success = await fetchAndSavePage(id, 'import');
        if (success) found++;
        
        // Small delay to be nice to the server
        await new Promise(r => setTimeout(r, 100));
    }
    
    console.log(`\n✅ Import scan complete: ${found} chapters found from ${scanned} checked`);
}

// Scan Export tariff
async function scanExportTariff() {
    console.log('\n📤 Scanning EXPORT Tariff...');
    
    try {
        const url = 'https://shaarolami-query.customs.mof.gov.il/CustomspilotWeb/he/CustomsBook/Export/ExportCustomsEntry';
        const response = await fetchUrl(url);
        
        if (response.status === 200 && response.data.length > 1000) {
            const text = extractText(response.data);
            const hsCodes = parseHSCodes(response.data);
            
            await setDoc(doc(db, 'tariff_chapters', 'export_main'), {
                chapterId: 'export',
                chapterName: 'תעריף יצוא',
                source: 'export',
                content: text.substring(0, 900000),
                hsCodes: hsCodes.slice(0, 1000),
                hsCodeCount: hsCodes.length,
                updatedAt: new Date().toISOString()
            });
            
            console.log(`✅ Export tariff saved (${hsCodes.length} HS codes)`);
            stats.saved++;
        }
    } catch (error) {
        console.log('❌ Export scan failed:', error.message);
    }
}

// Scan Autonomy tariff
async function scanAutonomyTariff() {
    console.log('\n🔄 Scanning AUTONOMY Tariff...');
    
    try {
        const url = 'https://shaarolami-query.customs.mof.gov.il/CustomspilotWeb/he/CustomsBook/Autonomy/AutonomyCustomsEntry';
        const response = await fetchUrl(url);
        
        if (response.status === 200 && response.data.length > 1000) {
            const text = extractText(response.data);
            const hsCodes = parseHSCodes(response.data);
            
            await setDoc(doc(db, 'tariff_chapters', 'autonomy_main'), {
                chapterId: 'autonomy',
                chapterName: 'תעריף אוטונומי',
                source: 'autonomy',
                content: text.substring(0, 900000),
                hsCodes: hsCodes.slice(0, 1000),
                hsCodeCount: hsCodes.length,
                updatedAt: new Date().toISOString()
            });
            
            console.log(`✅ Autonomy tariff saved (${hsCodes.length} HS codes)`);
            stats.saved++;
        }
    } catch (error) {
        console.log('❌ Autonomy scan failed:', error.message);
    }
}

// Log final stats
async function logScanResults() {
    try {
        await setDoc(doc(db, 'scanner_logs', `scan_${Date.now()}`), {
            timestamp: new Date().toISOString(),
            type: 'full_api_scan_v3',
            saved: stats.saved,
            failed: stats.failed,
            hsCodesTotal: stats.hsCodesTotal,
            status: 'complete'
        });
    } catch (error) {
        console.log('Could not save log:', error.message);
    }
}

// Main
async function main() {
    console.log('==========================================');
    console.log('🚀 RPA-PORT Customs API Scanner v3.0');
    console.log('📅 ' + new Date().toISOString());
    console.log('==========================================');
    
    await scanImportTariff();
    await scanExportTariff();
    await scanAutonomyTariff();
    
    await logScanResults();
    
    console.log('\n==========================================');
    console.log('📊 SCAN COMPLETE');
    console.log(`✅ Total saved: ${stats.saved}`);
    console.log(`❌ Total failed: ${stats.failed}`);
    console.log(`🏷️ Total HS codes: ${stats.hsCodesTotal}`);
    console.log('==========================================');
}

main()
    .then(() => {
        console.log('\n✅ Done');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    });
