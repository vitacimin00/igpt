import fs from 'fs';
import path from 'path';

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
];

class AccountManager {
    constructor() {
        this.accountsFile = 'data/accounts.json';
        this.accountsDir = 'accounts';
        this.sessionsDir = 'sessions';
        this.ensureDirectories();
    }

    ensureDirectories() {
        const dirs = [this.accountsDir, this.sessionsDir, 'data'];
        dirs.forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });

        if (!fs.existsSync(this.accountsFile)) {
            fs.writeFileSync(this.accountsFile, JSON.stringify({ accounts: [] }, null, 2));
        }
    }

    loadAccounts() {
        try {
            const data = fs.readFileSync(this.accountsFile, 'utf8');
            const parsed = JSON.parse(data);
            // Ensure accounts array exists
            if (!parsed || !Array.isArray(parsed.accounts)) {
                return { accounts: [] };
            }
            return parsed;
        } catch (error) {
            return { accounts: [] };
        }
    }

    saveAccounts(data) {
        fs.writeFileSync(this.accountsFile, JSON.stringify(data, null, 2));
    }

    addAccount(email, password, twoFASecret) {
        const accounts = this.loadAccounts();

        // Ensure accounts array exists
        if (!accounts || !Array.isArray(accounts.accounts)) {
            accounts.accounts = [];
        }

        // Check if account already exists
        const existingAccount = accounts.accounts.find(acc => acc.email === email);
        if (existingAccount) {
            return { success: false, message: '❌ Email sudah terdaftar!' };
        }

        const accountId = `acc_${Date.now()}`;
        const newAccount = {
            id: accountId,
            email,
            password,
            twoFASecret,
            inviteCount: 0,
            maxInvites: parseInt(process.env.MAX_INVITES_PER_ACCOUNT) || 5,
            status: 'active',
            createdAt: new Date().toISOString(),
            lastUsed: null,
            userAgent: this.assignUserAgent()
        };

        accounts.accounts.push(newAccount);
        this.saveAccounts(accounts);

        // Create account directory
        const accountDir = path.join(this.accountsDir, accountId);
        if (!fs.existsSync(accountDir)) {
            fs.mkdirSync(accountDir, { recursive: true });
        }

        return {
            success: true,
            message: `✅ Akun berhasil ditambahkan!\n📧 Email: ${email}\n🆔 ID: ${accountId}`,
            accountId
        };
    }

    getAvailableAccount() {
        const accounts = this.loadAccounts();

        // Ensure accounts array exists
        if (!accounts || !Array.isArray(accounts.accounts)) {
            return null;
        }

        // Find account with inviteCount < maxInvites and status active
        const availableAccount = accounts.accounts.find(
            acc => acc.status === 'active' && acc.inviteCount < acc.maxInvites
        );

        return availableAccount || null;
    }

    getAccountById(accountId) {
        const accounts = this.loadAccounts();
        if (!accounts || !Array.isArray(accounts.accounts)) {
            return null;
        }
        return accounts.accounts.find(acc => acc.id === accountId);
    }

    incrementInviteCount(accountId) {
        const accounts = this.loadAccounts();

        if (!accounts || !Array.isArray(accounts.accounts)) {
            return false;
        }

        const account = accounts.accounts.find(acc => acc.id === accountId);

        if (account) {
            account.inviteCount++;
            account.lastUsed = new Date().toISOString();

            // If reached max invites, mark as full
            if (account.inviteCount >= account.maxInvites) {
                account.status = 'full';
            }

            this.saveAccounts(accounts);
            return true;
        }

        return false;
    }

    getAccountStats() {
        const accounts = this.loadAccounts();

        if (!accounts || !Array.isArray(accounts.accounts)) {
            return { total: 0, active: 0, full: 0, totalInvites: 0 };
        }

        const total = accounts.accounts.length;
        const active = accounts.accounts.filter(acc => acc.status === 'active').length;
        const full = accounts.accounts.filter(acc => acc.status === 'full').length;
        const totalInvites = accounts.accounts.reduce((sum, acc) => sum + acc.inviteCount, 0);

        return {
            total,
            active,
            full,
            totalInvites
        };
    }

    listAccounts() {
        const accounts = this.loadAccounts();
        if (!accounts || !Array.isArray(accounts.accounts)) {
            return [];
        }
        return accounts.accounts;
    }

    resetAccountInvites(accountId) {
        const accounts = this.loadAccounts();

        if (!accounts || !Array.isArray(accounts.accounts)) {
            return { success: false, message: '❌ Data akun tidak valid!' };
        }

        const account = accounts.accounts.find(acc => acc.id === accountId);

        if (account) {
            account.inviteCount = 0;
            account.status = 'active';
            this.saveAccounts(accounts);
            return { success: true, message: '✅ Invite count berhasil direset!' };
        }

        return { success: false, message: '❌ Akun tidak ditemukan!' };
    }

    deleteAccount(accountId) {
        const accounts = this.loadAccounts();

        if (!accounts || !Array.isArray(accounts.accounts)) {
            return { success: false, message: '❌ Data akun tidak valid!' };
        }

        const index = accounts.accounts.findIndex(acc => acc.id === accountId);

        if (index !== -1) {
            const account = accounts.accounts[index];
            accounts.accounts.splice(index, 1);
            this.saveAccounts(accounts);

            // Delete account directory
            const accountDir = path.join(this.accountsDir, accountId);
            if (fs.existsSync(accountDir)) {
                fs.rmSync(accountDir, { recursive: true, force: true });
            }

            return {
                success: true,
                message: `✅ Akun ${account.email} berhasil dihapus!`
            };
        }

        return { success: false, message: '❌ Akun tidak ditemukan!' };
    }

    getAccountByEmail(email) {
        const accounts = this.loadAccounts();
        if (!accounts || !Array.isArray(accounts.accounts)) {
            return null;
        }
        return accounts.accounts.find(acc => acc.email.toLowerCase() === email.toLowerCase());
    }

    deleteAccountByEmail(email) {
        const accounts = this.loadAccounts();

        if (!accounts || !Array.isArray(accounts.accounts)) {
            return { success: false, message: '❌ Data akun tidak valid!' };
        }

        const index = accounts.accounts.findIndex(acc => acc.email.toLowerCase() === email.toLowerCase());

        if (index !== -1) {
            const account = accounts.accounts[index];
            accounts.accounts.splice(index, 1);
            this.saveAccounts(accounts);

            // Delete account directory
            const accountDir = path.join(this.accountsDir, account.id);
            if (fs.existsSync(accountDir)) {
                fs.rmSync(accountDir, { recursive: true, force: true });
            }

            // Delete session
            this.deleteSession(account.id);

            return {
                success: true,
                message: `✅ Akun ${account.email} berhasil dihapus!`
            };
        }

        return { success: false, message: '❌ Akun dengan email tersebut tidak ditemukan!' };
    }

    decrementInviteCount(accountId) {
        const accounts = this.loadAccounts();

        if (!accounts || !Array.isArray(accounts.accounts)) {
            return false;
        }

        const account = accounts.accounts.find(acc => acc.id === accountId);

        if (account && account.inviteCount > 0) {
            account.inviteCount--;

            // Reactivate if was full
            if (account.status === 'full' && account.inviteCount < account.maxInvites) {
                account.status = 'active';
            }

            this.saveAccounts(accounts);
            return true;
        }

        return false;
    }

    getSessionPath(accountId) {
        return path.join(this.accountsDir, accountId, 'chatgpt-session.json');
    }

    hasSession(accountId) {
        return fs.existsSync(this.getSessionPath(accountId));
    }

    deleteSession(accountId) {
        const sessionPath = this.getSessionPath(accountId);
        if (fs.existsSync(sessionPath)) {
            fs.unlinkSync(sessionPath);
            console.log(`🗑️ Session dihapus untuk akun ${accountId}`);
        }
    }

    assignUserAgent() {
        // Get all currently used UAs to avoid duplicates when possible
        const accounts = this.loadAccounts();
        const usedUAs = new Set((accounts.accounts || []).map(acc => acc.userAgent).filter(Boolean));

        // Try to find unused UA first
        const available = USER_AGENTS.filter(ua => !usedUAs.has(ua));
        if (available.length > 0) {
            return available[Math.floor(Math.random() * available.length)];
        }

        // If all used, pick random
        return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    }

    getUserAgent(accountId) {
        const account = this.getAccountById(accountId);
        if (account && account.userAgent) {
            return account.userAgent;
        }
        // Fallback: assign one and save
        const ua = this.assignUserAgent();
        const accounts = this.loadAccounts();
        const acc = accounts.accounts.find(a => a.id === accountId);
        if (acc) {
            acc.userAgent = ua;
            this.saveAccounts(accounts);
        }
        return ua;
    }
}

export default AccountManager;
