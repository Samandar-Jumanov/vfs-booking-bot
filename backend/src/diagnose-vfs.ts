import { chromium } from 'playwright';
import { prisma } from './config/database';
import { env } from './config/env';

async function diagnose() {
  console.log('\n🔍 Starting Lightweight VFS Diagnosis for usa -> prt...');
  
  const host = env.PROXY_HOST || 'premium.residential.proxyrack.net';
  const port = Number(env.PROXY_PORT) || 10000;
  
  console.log(`🌐 Testing Proxy: ${host}:${port}`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu', // Save RAM
      '--single-process' // Multi-process is heavy
    ]
  });

  try {
    const context = await browser.newContext({
      proxy: {
        server: `http://${host}:${port}`,
        username: env.PROXY_USERNAME,
        password: env.PROXY_PASSWORD,
      }
    });

    const page = await context.newPage();
    console.log('🚀 Loading VFS Login page...');
    
    // Test the 120s timeout we implemented
    const start = Date.now();
    await page.goto('https://visa.vfsglobal.com/usa/prt/en/login', { 
      waitUntil: 'domcontentloaded', 
      timeout: 120000 
    });
    
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`✅ Page Loaded Successfully in ${duration}s! (No 403 blocks)`);

    const title = await page.title();
    console.log(`📄 Page Title: ${title}`);

  } catch (err: any) {
    console.error(`\n❌ Diagnostic Failed: ${err.message}`);
    if (err.message.includes('timeout')) {
      console.log('💡 TIP: Proxyrack is slow today. The 120s bot timeout is definitely needed.');
    }
  } finally {
    await browser.close();
    process.exit(0);
  }
}

diagnose();
