(function registerAdminAuth(global) {
    const modules = global.LumiListModules || (global.LumiListModules = {});
    
    let isAdminAuthenticated = false;
    let adminData = null;

    /**
     * Fetches admin credentials from the JSON file.
     * In a real extension, this would be a local file or a fetch to a secure endpoint.
     */
    async function fetchAdminCredentials() {
        try {
            const response = await fetch('newtab/admin/admin.json');
            if (!response.ok) throw new Error('Failed to load admin configuration');
            adminData = await response.json();
            return adminData;
        } catch (error) {
            console.error('Error loading admin credentials:', error);
            return null;
        }
    }

    /**
     * Verifies if the provided password matches any admin password in the list.
     */
    async function verifyAdminPassword(password) {
        if (!adminData) {
            await fetchAdminCredentials();
        }
        
        if (adminData && Array.isArray(adminData.admins)) {
            // Check if password matches any admin in the array
            const match = adminData.admins.find(admin => admin.password === password);
            if (match) {
                isAdminAuthenticated = true;
                return true;
            }
        } else if (adminData && adminData.admin && adminData.admin.password === password) {
            // Fallback for single admin structure
            isAdminAuthenticated = true;
            return true;
        }
        return false;
    }

    /**
     * Checks if the admin is currently authenticated.
     */
    function isAuthenticated() {
        return isAdminAuthenticated;
    }

    /**
     * Resets authentication state.
     */
    function logout() {
        isAdminAuthenticated = false;
    }

    // Register module
    modules.adminAuth = {
        verifyAdminPassword,
        isAuthenticated,
        logout
    };

})(window);
