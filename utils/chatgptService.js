import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import ChatGPTLoginService from './chatgptLoginService.js';

chromium.use(StealthPlugin());

class ChatGPTService {
    constructor(accountManager) {
        this.accountManager = accountManager;
        this.loginService = new ChatGPTLoginService(accountManager);
    }

    async handleWorkspaceOnboarding(page) {
        try {
            const modalTitle = page.locator('text=Your ChatGPT Business workspace is ready');
            if (await modalTitle.count() === 0) {
                return;
            }

            console.log('🧭 Onboarding workspace detected, selecting option...');

            const optionSelectors = [
                'label:has-text("Start as empty workspace") input[type="radio"]',
                'label:has-text("Transfer chat history and GPTs") input[type="radio"]',
                'button:has-text("Start as empty workspace")',
                'button:has-text("Transfer chat history and GPTs")'
            ];

            for (const selector of optionSelectors) {
                const option = page.locator(selector).first();
                if (await option.count() > 0) {
                    try {
                        if (selector.includes('input')) {
                            const isChecked = await option.isChecked();
                            if (!isChecked) {
                                await option.check();
                            }
                        } else {
                            await option.click();
                        }
                        break;
                    } catch (e) {
                        continue;
                    }
                }
            }

            const continueButton = page.locator('button:has-text("Continue")').first();
            if (await continueButton.count() > 0) {
                await continueButton.click();
                await page.waitForTimeout(1500);
                console.log('✅ Onboarding workspace selesai');
            }
        } catch (e) {
            console.log('ℹ️ Onboarding workspace tidak perlu atau gagal diproses');
        }
    }

    async inviteTeamMember(account, targetEmail) {
        console.log(`📧 Invite ${targetEmail} via ${account.email}`);

        if (!this.accountManager.hasSession(account.id)) {
            console.log('🔐 Login pertama kali...');
            const loginResult = await this.loginService.loginAccount(account);
            if (!loginResult.success) {
                return loginResult;
            }
        }

        const browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
            ]
        });

        const sessionPath = this.accountManager.getSessionPath(account.id);
        const userAgent = this.accountManager.getUserAgent(account.id);
        const context = await browser.newContext({
            storageState: sessionPath,
            viewport: { width: 1280, height: 720 },
            userAgent
        });

        const page = await context.newPage();

        try {
            // Smart retry system for ChatGPT with exponential backoff

            let maxRetries = 3;
            let success = false;
            let lastError = '';

            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    if (attempt > 0) {
                        const waitTime = 3000 + (attempt * 2000);
                        console.log(`🔄 Retry ${attempt}/${maxRetries - 1} - tunggu ${waitTime / 1000}s...`);
                        await page.waitForTimeout(waitTime);
                    }

                    if (attempt === 0) {
                        await page.goto('https://chatgpt.com/', {
                            waitUntil: 'domcontentloaded',
                            timeout: 45000
                        });
                    } else {
                        console.log('🔃 Reload halaman...');
                        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                    }

                    await page.waitForTimeout(2000);

                    const errorSelectors = [
                        'text=Gateway time-out',
                        'text=504',
                        'text=502 Bad Gateway',
                        'text=503 Service',
                        'text=Error',
                        'text=Cloudflare'
                    ];

                    let hasError = false;
                    for (const selector of errorSelectors) {
                        if (await page.locator(selector).count() > 0) {
                            hasError = true;
                            lastError = selector;
                            console.log(`⚠️ Detected: ${selector}`);
                            break;
                        }
                    }

                    if (!hasError) {
                        try {
                            await page.waitForLoadState('networkidle', { timeout: 25000 });
                        } catch (e) {
                            const pageReady = await page.locator('text=ChatGPT, [data-testid]').count() > 0;
                            if (!pageReady) {
                                throw new Error('Page not ready');
                            }
                        }

                        success = true;

                        break;
                    }

                    if (attempt === maxRetries - 2) {
                        console.log('🚨 Last attempt coming up...');
                    }

                } catch (e) {
                    lastError = e.message;
                    if (attempt < maxRetries - 1) {
                        console.log(`⚠️ Error: ${e.message}`);
                    } else {
                        throw e;
                    }
                }
            }

            if (!success) {
                await browser.close();
                return {
                    success: false,
                    message: `❌ ChatGPT sedang down (${lastError}). Coba lagi dalam beberapa menit.`
                };
            }

            // ========== SESSION EXPIRED DETECTION ==========
            const currentUrl = page.url();
            const isSessionExpired = currentUrl.includes('auth.openai.com') ||
                currentUrl.includes('/auth/login') ||
                currentUrl.includes('login.openai.com') ||
                (!currentUrl.includes('chatgpt.com'));

            if (isSessionExpired) {
                console.log(`⚠️ Session expired untuk akun ${account.email} (URL: ${currentUrl})`);
                console.log('🔄 Auto re-login akun yang sama...');

                await browser.close();

                // Hapus session lama
                this.accountManager.deleteSession(account.id);

                // Re-login akun yang sama
                const loginResult = await this.loginService.loginAccount(account);
                if (!loginResult.success) {
                    return {
                        success: false,
                        message: `❌ Session expired & re-login gagal: ${loginResult.message}`
                    };
                }

                console.log('✅ Re-login berhasil! Melanjutkan invite...');

                // Buka browser baru dengan session fresh
                const newBrowser = await chromium.launch({
                    headless: true,
                    args: ['--disable-blink-features=AutomationControlled']
                });

                const newContext = await newBrowser.newContext({
                    storageState: sessionPath,
                    viewport: { width: 1280, height: 720 },
                    userAgent: this.accountManager.getUserAgent(account.id)
                });

                const newPage = await newContext.newPage();

                try {
                    await newPage.goto('https://chatgpt.com/', {
                        waitUntil: 'domcontentloaded',
                        timeout: 45000
                    });
                    await newPage.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => { });

                    return await this._continueInvite(newPage, newContext, newBrowser, account, targetEmail, sessionPath);
                } catch (e) {
                    await newBrowser.close();
                    return {
                        success: false,
                        message: `❌ Re-login berhasil tapi gagal buka ChatGPT: ${e.message}`
                    };
                }
            }
            // ========== END SESSION EXPIRED DETECTION ==========

            // Session valid — lanjut invite
            return await this._continueInvite(page, context, browser, account, targetEmail, sessionPath);

        } catch (error) {
            console.error('❌ Error:', error.message);
            try { await browser.close(); } catch (e) { }
            return {
                success: false,
                message: `❌ Invite gagal: ${error.message}`
            };
        }
    }

    /**
     * Shared invite flow — dipakai oleh normal path dan post-re-login path
     */
    async _continueInvite(page, context, browser, account, targetEmail, sessionPath) {
        try {
            await this.handleWorkspaceOnboarding(page);

            // Buka invite via profile menu
            console.log('🔍 Membuka invite dialog...');
            let inviteClicked = false;

            const profileSelectors = [
                '[data-testid="accounts-profile-button"]',
                'button[aria-label="User menu"]',
                'button:has-text("Profile")',
                'div[data-radix-collection-item] button'
            ];
            let profileClicked = false;
            for (const selector of profileSelectors) {
                try {
                    const element = page.locator(selector).first();
                    if (await element.count() > 0) {
                        await element.click({ timeout: 5000 });
                        profileClicked = true;
                        break;
                    }
                } catch (e) { continue; }
            }
            if (!profileClicked) throw new Error('Profile button tidak ditemukan');
            await page.waitForTimeout(1500);

            const menuSelectors = [
                '[data-testid="settings-menu-item-invite-teammates"]',
                'text="Invite teammates"',
                'text="Add teammates"'
            ];
            for (const selector of menuSelectors) {
                try {
                    const element = page.locator(selector).first();
                    if (await element.count() > 0) {
                        await element.click({ timeout: 5000 });
                        inviteClicked = true;
                        break;
                    }
                } catch (e) { continue; }
            }

            if (!inviteClicked) {
                throw new Error('Tidak dapat menemukan tombol invite.');
            }
            console.log('✅ Invite dialog dibuka');

            // Isi email
            const emailInput = page.locator('input[type="email"]').first();
            try {
                await emailInput.waitFor({ state: 'visible', timeout: 10000 });
            } catch (e) {
                throw new Error('Dialog invite tidak muncul.');
            }

            console.log(`📧 Invite ${targetEmail}...`);
            await emailInput.fill(targetEmail);
            await page.waitForTimeout(500);

            // Next
            const nextButton = page.locator('button:has-text("Next"), button:has-text("Continue")').first();
            await nextButton.waitFor({ state: 'visible', timeout: 5000 });
            await nextButton.click();
            await page.waitForTimeout(1500);

            // Uncheck resend checkbox
            try {
                const checkboxSelectors = [
                    'input[type="checkbox"]',
                    'input[data-testid="resend-emails"]',
                    'label:has-text("Resend") input',
                    'label:has-text("existing") input'
                ];
                for (const selector of checkboxSelectors) {
                    const checkbox = page.locator(selector).first();
                    if (await checkbox.count() > 0) {
                        const isChecked = await checkbox.isChecked();
                        if (isChecked) {
                            await checkbox.uncheck();
                            await page.waitForTimeout(500);
                        }
                        break;
                    }
                }
            } catch (e) { }

            // Send
            await page.click('button:has-text("Send invites")');
            await page.waitForTimeout(500);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(2000);

            console.log('✅ Invite berhasil!');

            // Update session
            try {
                await context.storageState({ path: sessionPath });
            } catch (e) {
                console.log('⚠️ Gagal update session, tapi invite tetap berhasil');
            }

            await browser.close();
            this.accountManager.incrementInviteCount(account.id);

            return {
                success: true,
                message: `✅ Invite berhasil dikirim ke ${targetEmail}!`
            };

        } catch (error) {
            console.error('❌ Error in invite flow:', error.message);
            try { await browser.close(); } catch (e) { }
            return {
                success: false,
                message: `❌ Invite gagal: ${error.message}`
            };
        }
    }

    /**
     * Kick member dari workspace ChatGPT via Playwright
     * URL: https://chatgpt.com/admin/members
     * Flow: Buka members page → cari row email → klik "..." → klik "Remove member"
     */
    async kickTeamMember(account, targetEmail) {
        console.log(`🔨 Memulai kick ${targetEmail} dari akun ${account.email}...`);

        // Auto login if no session
        if (!this.accountManager.hasSession(account.id)) {
            console.log('🔐 Session tidak ditemukan, login dulu...');
            const loginResult = await this.loginService.loginAccount(account);
            if (!loginResult.success) {
                return loginResult;
            }
        }

        const browser = await chromium.launch({
            headless: true,
            args: ['--disable-blink-features=AutomationControlled']
        });

        const sessionPath = this.accountManager.getSessionPath(account.id);
        const userAgent = this.accountManager.getUserAgent(account.id);
        const context = await browser.newContext({
            storageState: sessionPath,
            viewport: { width: 1280, height: 720 },
            userAgent
        });

        const page = await context.newPage();

        try {
            // Buka halaman admin members
            await page.goto('https://chatgpt.com/admin/members', {
                waitUntil: 'domcontentloaded',
                timeout: 45000
            });
            await page.waitForTimeout(3000);

            // Session expired check
            const currentUrl = page.url();
            if (currentUrl.includes('auth.openai.com') || !currentUrl.includes('chatgpt.com')) {
                console.log('⚠️ Session expired, re-login...');
                await browser.close();
                this.accountManager.deleteSession(account.id);

                const loginResult = await this.loginService.loginAccount(account);
                if (!loginResult.success) {
                    return { success: false, message: `❌ Session expired & re-login gagal: ${loginResult.message}` };
                }

                // Retry with new session
                const newBrowser = await chromium.launch({
                    headless: true,
                    args: ['--disable-blink-features=AutomationControlled']
                });
                const newContext = await newBrowser.newContext({
                    storageState: sessionPath,
                    viewport: { width: 1280, height: 720 },
                    userAgent
                });
                const newPage = await newContext.newPage();

                try {
                    await newPage.goto('https://chatgpt.com/admin/members', {
                        waitUntil: 'domcontentloaded',
                        timeout: 45000
                    });
                    await newPage.waitForTimeout(3000);
                    return await this._continueKick(newPage, newContext, newBrowser, targetEmail, sessionPath);
                } catch (e) {
                    await newBrowser.close();
                    return { success: false, message: `❌ Gagal buka admin page setelah re-login: ${e.message}` };
                }
            }

            return await this._continueKick(page, context, browser, targetEmail, sessionPath);

        } catch (error) {
            console.error('❌ Error kick:', error.message);
            try { await browser.close(); } catch (e) { }
            return { success: false, message: `❌ Kick gagal: ${error.message}` };
        }
    }

    /**
     * Flow kick di halaman /admin/members:
     * 1. Cari row yang mengandung email target
     * 2. Klik tombol "..." (kebab) di row tersebut
     * 3. Klik "Remove member" dari dropdown
     */
    async _continueKick(page, context, browser, targetEmail, sessionPath) {
        try {
            // Tunggu halaman Members load
            try {
                await page.waitForSelector('text=Members', { timeout: 10000 });
            } catch (e) {
                throw new Error('Halaman Members tidak muncul.');
            }

            try {
                const usersTab = page.locator('text="Users"').first();
                if (await usersTab.count() > 0) {
                    await usersTab.click();
                    await page.waitForTimeout(1500);
                }
            } catch (e) { }

            // Cari email target
            await page.waitForTimeout(1000);
            const emailVisible = await page.locator(`text="${targetEmail}"`).first().count();
            if (emailVisible === 0) {
                await browser.close();
                return {
                    success: false,
                    message: `❌ ${targetEmail} tidak ditemukan di member list.`
                };
            }
            console.log(`🔍 Kick ${targetEmail}...`);

            // Cari & klik tombol "..." di row member

            const kebabHandle = await page.evaluateHandle((email) => {
                // Cari element yang contain email text
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                let emailNode = null;
                while (walker.nextNode()) {
                    if (walker.currentNode.textContent.trim() === email) {
                        emailNode = walker.currentNode.parentElement;
                        break;
                    }
                }
                if (!emailNode) return null;

                // Naik ke parent row — cari element yang cukup besar (row container)
                let row = emailNode;
                for (let i = 0; i < 10; i++) {
                    if (!row.parentElement) break;
                    row = row.parentElement;
                    // Row biasanya punya width hampir selebar page dan height terbatas
                    const rect = row.getBoundingClientRect();
                    if (rect.width > 500 && rect.height > 30 && rect.height < 120) {
                        break;
                    }
                }

                // Cari button "..." di dalam row ini
                const buttons = row.querySelectorAll('button');
                for (const btn of buttons) {
                    const text = btn.textContent.trim();
                    // Tombol "..." biasanya punya text pendek atau aria-label
                    if (text === '...' || text === '⋯' || text === '···' || text === '…' ||
                        text.length <= 3 || btn.getAttribute('aria-label')?.includes('more') ||
                        btn.getAttribute('aria-label')?.includes('option') ||
                        btn.getAttribute('aria-label')?.includes('menu')) {
                        return btn;
                    }
                }

                // Fallback: ambil button terakhir di row (biasanya kebab)
                if (buttons.length > 0) {
                    return buttons[buttons.length - 1];
                }

                return null;
            }, targetEmail);

            const kebabElement = kebabHandle.asElement();
            if (!kebabElement) {
                await browser.close();
                return {
                    success: false,
                    message: `❌ Tombol "..." untuk ${targetEmail} tidak ditemukan.`
                };
            }

            await kebabElement.click();
            await page.waitForTimeout(2000);

            // Klik "Remove member"
            let removeClicked = false;

            try {
                const removeBtn = page.getByText('Remove member', { exact: true });
                if (await removeBtn.count() > 0) {
                    await removeBtn.first().click({ force: true });
                    removeClicked = true;
                }
            } catch (e) { }

            if (!removeClicked) {
                try {
                    const removeBtn = page.getByRole('menuitem', { name: 'Remove member' });
                    if (await removeBtn.count() > 0) {
                        await removeBtn.first().click({ force: true });
                        removeClicked = true;
                    }
                } catch (e) { }
            }

            if (!removeClicked) {
                await browser.close();
                return {
                    success: false,
                    message: `❌ Tombol "Remove member" tidak ditemukan.`
                };
            }

            // Konfirmasi (Delete/Remove/Confirm)
            await page.waitForTimeout(3000);

            try {
                const confirmNames = ['Delete', 'Remove', 'Confirm'];
                for (const name of confirmNames) {
                    const btn = page.getByRole('button', { name, exact: true });
                    if (await btn.count() > 0) {
                        await btn.first().click({ force: true });
                        break;
                    }
                }
            } catch (e) { }

            // Verifikasi
            await page.waitForTimeout(8000);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(5000);

            const stillExists = await page.locator(`text="${targetEmail}"`).count();
            if (stillExists > 0) {
                await browser.close();
                return {
                    success: false,
                    message: `⚠️ Kick gagal — ${targetEmail} masih ada setelah reload.`
                };
            }

            // Save session
            try {
                await context.storageState({ path: sessionPath });
            } catch (e) { }

            await browser.close();
            console.log(`✅ Kick ${targetEmail} berhasil!`);

            return {
                success: true,
                message: `✅ ${targetEmail} berhasil di-remove dari workspace!`
            };

        } catch (error) {
            console.error('❌ Error in kick flow:', error.message);
            try { await browser.close(); } catch (e) { }
            return {
                success: false,
                message: `❌ Kick gagal: ${error.message}`
            };
        }
    }
}

export default ChatGPTService;

