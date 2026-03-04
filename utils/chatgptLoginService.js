import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import speakeasy from 'speakeasy';

chromium.use(StealthPlugin());

class ChatGPTLoginService {
    constructor(accountManager) {
        this.accountManager = accountManager;
    }

    async loginAccount(account) {
        console.log(`🔐 Login ${account.email}...`);

        const browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
            ]
        });

        const context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: this.accountManager.getUserAgent(account.id)
        });

        const page = await context.newPage();

        try {
            await page.goto('https://chat.openai.com/', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });

            await page.waitForTimeout(3000);

            // Click login button
            await page.click('button:has-text("Log in")');
            await page.waitForTimeout(2000);

            // Input email
            await page.waitForSelector('input[type="email"]', { timeout: 10000 });
            await page.fill('input[type="email"]', account.email);
            await page.waitForTimeout(1000);

            // Click continue
            await page.click('button.btn-primary[type="submit"]');
            await page.waitForTimeout(2000);

            // Input password
            const passwordInput = await page.waitForSelector('input[type="password"]');
            await passwordInput.fill(account.password);

            // Click submit
            await page.click('button[type="submit"]');
            await page.waitForTimeout(3000);

            // Check if 2FA is needed — check both URL and input field
            const currentUrlAfterPw = page.url();
            let has2FA = currentUrlAfterPw.includes('mfa-challenge') || currentUrlAfterPw.includes('mfa');

            if (!has2FA) {
                has2FA = await page.locator('input[type="text"][autocomplete="one-time-code"], input[name="code"]').count() > 0;
            }

            // Retry: wait a bit more and check again
            if (!has2FA) {
                await page.waitForTimeout(3000);
                const urlRetry = page.url();
                has2FA = urlRetry.includes('mfa-challenge') || urlRetry.includes('mfa');
                if (!has2FA) {
                    has2FA = await page.locator('input[type="text"][autocomplete="one-time-code"], input[name="code"]').count() > 0;
                }
            }

            if (has2FA && account.twoFASecret) {
                console.log('🔑 2FA terdeteksi, generating kode...');

                // Wait for input field to appear (might not be loaded yet if detected via URL)
                const codeInput = await page.waitForSelector(
                    'input[type="text"][autocomplete="one-time-code"], input[name="code"]',
                    { timeout: 15000 }
                );

                const token = speakeasy.totp({
                    secret: account.twoFASecret,
                    encoding: 'base32'
                });

                console.log('🔢 Kode 2FA:', token);
                await codeInput.fill(token);
                await page.click('button[type="submit"], button:has-text("Continue"), button:has-text("Verify")');
                console.log('✅ 2FA submitted');

                await page.waitForTimeout(1500);
                try {
                    await page.waitForURL(/chatgpt\.com|auth\.openai\.com\/workspace/, { timeout: 60000 });
                } catch (error) {
                    console.log('⚠️ Timeout URL redirect, lanjut cek...');
                }
            } else {
                // Kalau tidak ada 2FA, tunggu redirect setelah password
                console.log('⏳ Login tanpa 2FA...');
                await page.waitForTimeout(1500);
                try {
                    await page.waitForURL(/chatgpt\.com|auth\.openai\.com\/workspace/, { timeout: 60000 });
                    console.log('✅ URL berpindah setelah login.');
                } catch (error) {
                    console.log('⚠️ Timeout URL redirect, lanjut cek...');
                }
            }

            // Tunggu sebentar untuk memastikan redirect selesai
            await page.waitForTimeout(3000);

            // Handle workspace selection page - cek dengan cara yang benar
            const currentPageUrl = page.url();

            // Cek apakah ada button workspace
            const workspaceButtonExists = await page.locator('button[name="workspace_id"]').count() > 0;

            if (workspaceButtonExists) {
                console.log('🏢 Workspace terdeteksi, selecting...');

                try {
                    const firstButton = page.locator('button[name="workspace_id"]').first();
                    await firstButton.waitFor({ state: 'visible', timeout: 10000 });
                    await firstButton.scrollIntoViewIfNeeded();
                    await page.waitForTimeout(500);
                    await firstButton.click({ force: true });

                    try {
                        await page.waitForURL(/chatgpt\.com/, { timeout: 60000 });
                    } catch (urlError) {
                        console.log('⚠️ Redirect timeout');
                    }

                    await page.waitForTimeout(3000);
                } catch (error) {
                    console.log('❌ Error saat handle workspace:', error.message);
                    throw new Error('Gagal klik workspace: ' + error.message);
                }
            } else {
                console.log('✅ Tidak ada halaman workspace, langsung ke chat');
            }

            // Sekarang cek apakah berhasil login
            const currentUrl = page.url();
            const isLoggedIn = currentUrl.includes('chatgpt.com') && !currentUrl.includes('auth') && !currentUrl.includes('workspace');

            if (isLoggedIn) {
                console.log('✅ Login berhasil!');

                const sessionPath = this.accountManager.getSessionPath(account.id);
                await context.storageState({ path: sessionPath });

                await browser.close();
                return { success: true, message: 'Login berhasil!' };
            } else {
                throw new Error('Login gagal - URL masih di halaman auth');
            }

        } catch (error) {
            await browser.close();
            return { success: false, message: `Login gagal: ${error.message}` };
        }
    }
}

export default ChatGPTLoginService;
