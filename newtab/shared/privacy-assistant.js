(function registerPrivacyAssistant(global) {
    const modules = global.LumiListModules || (global.LumiListModules = {});

    /**
     * PASSWORD SECURITY ANALYSIS
     * -------------------------
     * Evaluates password strength based on length, character variety, and patterns.
     */
    function evaluatePasswordStrength(password) {
        if (!password) {
            return {
                strength: "none",
                score: 0,
                issues: ["No password provided"],
                suggestions: ["Provide a password to evaluate strength."]
            };
        }

        let score = 0;
        const issues = [];
        const suggestions = [];

        // 1. Length Check (minimum 8 characters)
        if (password.length < 8) {
            issues.push("Password is too short");
            suggestions.push("Use at least 8 characters.");
        } else {
            score += 25;
        }

        // 2. Character Variety Checks
        const hasUpper = /[A-Z]/.test(password);
        const hasLower = /[a-z]/.test(password);
        const hasNumber = /[0-9]/.test(password);
        const hasSpecial = /[^A-Za-z0-9]/.test(password);

        if (hasUpper) score += 15;
        else {
            issues.push("Missing uppercase letter");
            suggestions.push("Add at least one uppercase letter (A-Z).");
        }

        if (hasLower) score += 15;
        else {
            issues.push("Missing lowercase letter");
            suggestions.push("Add at least one lowercase letter (a-z).");
        }

        if (hasNumber) score += 15;
        else {
            issues.push("Missing number");
            suggestions.push("Add at least one number (0-9).");
        }

        if (hasSpecial) score += 15;
        else {
            issues.push("Missing special character");
            suggestions.push("Add at least one special character (e.g., !, @, #, $, %).");
        }

        // 3. Common / Unsafe Patterns Check
        const commonPasswords = ["123456", "password", "qwerty", "admin", "welcome"];
        const lowerPassword = password.toLowerCase();
        
        let isCommon = false;
        for (const common of commonPasswords) {
            if (lowerPassword.includes(common)) {
                isCommon = true;
                break;
            }
        }

        if (isCommon) {
            score = Math.max(0, score - 30);
            issues.push("Common or unsafe pattern detected");
            suggestions.push("Avoid using common words or sequential patterns like '123456' or 'password'.");
        } else if (password.length >= 12 && hasUpper && hasLower && hasNumber && hasSpecial) {
            score = Math.min(100, score + 15); // Bonus for extra long and complex passwords
        }

        // Determine Strength Label
        let strength = "weak";
        if (score >= 80) strength = "strong";
        else if (score >= 50) strength = "medium";

        return {
            strength,
            score: Math.min(100, score),
            issues,
            suggestions
        };
    }

    /**
     * PRIVACY ANALYSIS
     * ----------------
     * Analyzes bookmark content to determine if it's sensitive.
     */
    function analyzeBookmarkPrivacy(bookmark) {
        const { title = "", url = "", description = "", tags = "" } = bookmark;
        
        const sensitiveKeywords = [
            "bank", "finance", "crypto", "wallet", "investment", "credit", "account",
            "login", "auth", "signin", "signup", "password", "credential",
            "dashboard", "personal", "private", "internal", "work", "admin", "console",
            "document", "confidential", "secret", "draft", "project-x", "vpn",
            "intranet", "payroll", "medical", "health", "insurance", "legal"
        ];

        const combinedText = `${title} ${url} ${description} ${tags}`.toLowerCase();
        let isSensitive = false;
        let privacyReason = "No sensitive keywords detected.";
        let confidence = 50;

        // Check for keywords
        const detectedKeywords = sensitiveKeywords.filter(keyword => combinedText.includes(keyword));
        
        if (detectedKeywords.length > 0) {
            isSensitive = true;
            privacyReason = `Detected sensitive keywords: ${detectedKeywords.slice(0, 3).join(", ")}${detectedKeywords.length > 3 ? "..." : ""}.`;
            confidence = Math.min(100, 50 + (detectedKeywords.length * 10));
        }

        // Special URL checks
        try {
            const urlObj = new URL(url);
            const hostname = urlObj.hostname.toLowerCase();
            
            // Internal or common sensitive hostnames
            if (hostname.includes("internal") || hostname.includes("localhost") || hostname.startsWith("10.") || hostname.startsWith("192.168.")) {
                isSensitive = true;
                privacyReason = "URL indicates an internal or local network resource.";
                confidence = 95;
            }

            // Common finance/bank domains
            const financeDomains = ["paypal.com", "chase.com", "wellsfargo.com", "binance.com", "coinbase.com"];
            if (financeDomains.some(domain => hostname.includes(domain))) {
                isSensitive = true;
                privacyReason = "URL is associated with a known financial service.";
                confidence = 90;
            }
        } catch (e) {
            // Invalid URL, ignore
        }

        return {
            is_sensitive: isSensitive,
            reason: privacyReason,
            confidence
        };
    }

    /**
     * STORAGE RECOMMENDATION
     * ----------------------
     * Decides where to store the bookmark based on its sensitivity and tags.
     */
    function recommendStorage(privacyAnalysis, tags = "") {
        const isSensitive = privacyAnalysis.is_sensitive;
        const tagsLower = tags.toLowerCase();
        const isWork = tagsLower.includes("work") || tagsLower.includes("internal") || tagsLower.includes("office");

        if (isSensitive) {
            return {
                storage: "local",
                storage_reason: "Sensitive information should be stored locally for maximum privacy."
            };
        }

        if (isWork) {
            return {
                storage: "local",
                storage_reason: "Work-related or internal bookmarks are recommended for local storage."
            };
        }

        return {
            storage: "cloud",
            storage_reason: "Public or general bookmarks can be safely stored in the cloud for cross-device access."
        };
    }

    /**
     * MAIN ENTRY POINT
     * ----------------
     * Orchestrates the complete analysis.
     */
    function analyze(input) {
        const passwordAnalysis = evaluatePasswordStrength(input.password);
        const privacyAnalysis = analyzeBookmarkPrivacy(input.bookmark || {});
        const storageRecommendation = recommendStorage(privacyAnalysis, input.bookmark?.tags);

        return {
            password_analysis: passwordAnalysis,
            privacy_analysis: privacyAnalysis,
            storage_recommendation: {
                type: storageRecommendation.storage,
                reason: storageRecommendation.storage_reason
            }
        };
    }

    // Register module
    modules.privacyAssistant = {
        evaluatePasswordStrength,
        analyzeBookmarkPrivacy,
        recommendStorage,
        analyze
    };

})(window);
