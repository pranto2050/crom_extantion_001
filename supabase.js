/**
 * LumiList Supabase Configuration
 *
 * Initialize Supabase client with custom storage adapter for Chrome extension.
 * Uses chrome.storage.local for session persistence across extension contexts.
 */

// Supabase Configuration
const SUPABASE_URL = 'https://xbccmcszhnybxzlirjgk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhiY2NtY3N6aG55Ynh6bGlyamdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAyMTY1MjQsImV4cCI6MjA4NTc5MjUyNH0.BIJgjvzh2XBWBphVgU4O6XWh3dm8Sk1G1ycqt0okY9w';
const SUPABASE_AUTH_TOKEN_KEY_PATTERN = /^sb-.*-auth-token$/;
const storageShadowValues = new Map();

// Custom storage adapter for Chrome extension
// Uses chrome.storage.local instead of localStorage for persistence across contexts
const chromeStorageAdapter = {
    getItem: async (key) => {
        return new Promise((resolve) => {
            try {
                chrome.storage.local.get([key], (result) => {
                    if (chrome.runtime.lastError) {
                        console.error('chromeStorageAdapter getItem error:', chrome.runtime.lastError);
                        resolve(null);
                        return;
                    }
                    const value = result[key] ?? null;
                    storageShadowValues.set(key, value);
                    resolve(value);  // Use ?? to preserve falsy values like 0 or ''
                });
            } catch (e) {
                console.error('chromeStorageAdapter getItem exception:', e);
                resolve(null);
            }
        });
    },
    setItem: async (key, value) => {
        return new Promise((resolve, reject) => {
            try {
                chrome.storage.local.set({ [key]: value }, () => {
                    if (chrome.runtime.lastError) {
                        console.error('chromeStorageAdapter setItem error:', chrome.runtime.lastError);
                        // Reject on write errors - auth token not persisting is critical
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    storageShadowValues.set(key, value);
                    resolve();
                });
            } catch (e) {
                console.error('chromeStorageAdapter setItem exception:', e);
                reject(e);
            }
        });
    },
    removeItem: async (key) => {
        return new Promise((resolve) => {
            try {
                chrome.storage.local.get([key], (result) => {
                    if (chrome.runtime.lastError) {
                        console.error('chromeStorageAdapter removeItem preflight error:', chrome.runtime.lastError);
                        resolve();
                        return;
                    }

                    const currentValue = result[key] ?? null;
                    const lastKnownValue = storageShadowValues.has(key)
                        ? storageShadowValues.get(key)
                        : null;
                    const isSupabaseAuthToken = SUPABASE_AUTH_TOKEN_KEY_PATTERN.test(key);
                    const hasNewerSharedSession =
                        isSupabaseAuthToken &&
                        currentValue !== null &&
                        lastKnownValue !== null &&
                        currentValue !== lastKnownValue;

                    if (hasNewerSharedSession) {
                        console.warn('chromeStorageAdapter removeItem skipped for newer shared Supabase session');
                        storageShadowValues.set(key, currentValue);
                        resolve();
                        return;
                    }

                    chrome.storage.local.remove([key], () => {
                        if (chrome.runtime.lastError) {
                            console.error('chromeStorageAdapter removeItem error:', chrome.runtime.lastError);
                        } else {
                            storageShadowValues.delete(key);
                        }
                        // Don't reject on remove errors - less critical
                        resolve();
                    });
                });
            } catch (e) {
                console.error('chromeStorageAdapter removeItem exception:', e);
                resolve();
            }
        });
    }
};

// Supabase client instance (renamed to avoid conflict with library global)
let supabaseClient = null;

function initSupabase() {
    // Return existing client if already initialized (prevents "Multiple GoTrueClient instances" warning)
    if (supabaseClient) {
        return supabaseClient;
    }

    // The library exposes window.supabase with createClient method
    if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient) {
        try {
            supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                auth: {
                    storage: chromeStorageAdapter,
                    autoRefreshToken: true,
                    persistSession: true,
                    detectSessionInUrl: false  // We handle OAuth manually in handleAuthCallback() - disable to prevent double token processing
                }
            });
            

            // Hash clearing moved to handleAuthCallback() in newtab.js AFTER successful setSession()
            // This prevents the race condition where both Supabase auto-detection and manual handler use the same refresh token

            return supabaseClient;
        } catch (error) {
            console.error('Supabase client initialization failed:', error);
            // Return null so callers know initialization failed
            return null;
        }
    } else {
        console.error('Supabase library not loaded');
        return null;
    }
}

// Export for use in other files
if (typeof window !== 'undefined') {
    window.initSupabase = initSupabase;
    window.SUPABASE_URL = SUPABASE_URL;
    window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
    window.chromeStorageAdapter = chromeStorageAdapter;
}
