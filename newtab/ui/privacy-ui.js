(function registerPrivacyUI(global) {
    const modules = global.LumiListModules || (global.LumiListModules = {});
    const assistant = modules.privacyAssistant;
    const { escapeHtml } = modules.coreUtils || { escapeHtml: (t) => t };

    /**
     * Renders the privacy and security analysis results into a target container.
     */
    function renderAnalysis(containerId, analysis) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = '';
        container.classList.remove('hidden');

        const { password_analysis, privacy_analysis, storage_recommendation } = analysis;

        // 1. Password Security Section
        if (password_analysis.strength !== "none") {
            const pwdSection = document.createElement('div');
            pwdSection.className = 'analysis-section password-security';
            
            const strengthClass = `strength-${password_analysis.strength}`;
            
            pwdSection.innerHTML = `
                <div class="analysis-header">
                    <span class="analysis-title">Password Security</span>
                    <span class="strength-badge ${strengthClass}">${password_analysis.strength.toUpperCase()}</span>
                </div>
                <div class="score-bar-container">
                    <div class="score-bar-fill ${strengthClass}" style="width: ${password_analysis.score}%"></div>
                </div>
                <div class="analysis-details">
                    ${password_analysis.issues.length > 0 ? `
                        <div class="analysis-issues">
                            <strong>Issues:</strong>
                            <ul>${password_analysis.issues.map(issue => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>
                        </div>
                    ` : ''}
                    ${password_analysis.suggestions.length > 0 ? `
                        <div class="analysis-suggestions">
                            <strong>Suggestions:</strong>
                            <ul>${password_analysis.suggestions.map(sug => `<li>${escapeHtml(sug)}</li>`).join('')}</ul>
                        </div>
                    ` : ''}
                </div>
            `;
            container.appendChild(pwdSection);
        }

        // 2. Privacy Analysis Section
        const privacySection = document.createElement('div');
        privacySection.className = 'analysis-section privacy-check';
        
        const sensitivityLabel = privacy_analysis.is_sensitive ? 'SENSITIVE' : 'GENERAL';
        const sensitivityClass = privacy_analysis.is_sensitive ? 'sensitive' : 'general';

        privacySection.innerHTML = `
            <div class="analysis-header">
                <span class="analysis-title">Privacy Analysis</span>
                <span class="sensitivity-badge ${sensitivityClass}">${sensitivityLabel}</span>
            </div>
            <div class="analysis-details">
                <p><strong>Reason:</strong> ${escapeHtml(privacy_analysis.reason)}</p>
                <div class="confidence-info">Confidence: ${privacy_analysis.confidence}%</div>
            </div>
        `;
        container.appendChild(privacySection);

        // 3. Storage Recommendation Section
        const storageSection = document.createElement('div');
        storageSection.className = 'analysis-section storage-rec';
        
        const storageLabel = storage_recommendation.type.toUpperCase();
        const storageClass = `storage-${storage_recommendation.type}`;

        storageSection.innerHTML = `
            <div class="analysis-header">
                <span class="analysis-title">Storage Recommendation</span>
                <span class="storage-badge ${storageClass}">${storageLabel}</span>
            </div>
            <div class="analysis-details">
                <p>${escapeHtml(storage_recommendation.reason)}</p>
            </div>
        `;
        container.appendChild(storageSection);
    }

    /**
     * Attaches listeners to form inputs to trigger real-time analysis.
     */
    function attachAnalysisListeners(formId, containerId) {
        const form = document.getElementById(formId);
        if (!form) return;

        const inputs = form.querySelectorAll('input, textarea');
        const container = document.getElementById(containerId);

        const runAnalysis = () => {
            const formData = new FormData(form);
            const input = {
                password: formData.get('password'),
                bookmark: {
                    title: formData.get('title'),
                    url: formData.get('url'),
                    description: formData.get('description'),
                    tags: "" // Tags aren't in the form yet, but could be added
                }
            };

            // Only run if there's at least some data
            if (input.password || input.bookmark.title || input.bookmark.url) {
                const analysis = assistant.analyze(input);
                renderAnalysis(containerId, analysis);
            } else {
                container.classList.add('hidden');
                container.innerHTML = '';
            }
        };

        // Debounce analysis for performance
        let timeout;
        inputs.forEach(input => {
            input.addEventListener('input', () => {
                clearTimeout(timeout);
                timeout = setTimeout(runAnalysis, 300);
            });
        });
    }

    modules.privacyUI = {
        renderAnalysis,
        attachAnalysisListeners
    };

})(window);
