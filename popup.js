/**
 * MivaFocus Popup Script
 * Handles onboarding (department selection only) and global filter toggle
 * Filter controls (level/semester) are now on the LMS page
 */

class MivaFocusPopup {
  constructor() {
    this.userSettings = {};
    this.courseDB = null;
    this.departmentCourses = null;
    this.cacheKey = 'courseDBCache';
    this.cacheExpiry = 7 * 24 * 60 * 60 * 1000; // 7 days
    this.githubRawUrl = 'https://raw.githubusercontent.com/trust914/MivaFocus_Scraper/master/courses_database.json';
    this.lmsDomain = 'lms.miva.university';
    this.init();
  }

  async init() {
    try {
      await this.loadSettings();
      await this.loadAndCacheDB();
      this.renderUI();
      this.attachListeners();
    } catch (error) {
      console.error('[MivaFocus Popup] Init error:', error);
      this.showError('Failed to initialize. Please try again.');
    }
  }

  async loadSettings() {
    const result = await chrome.storage.sync.get('userSettings');
    this.userSettings = result.userSettings || {};
  }

  async saveSettings() {
    await chrome.storage.sync.set({ userSettings: this.userSettings });
  }

  async loadAndCacheDB() {
    try {
      const cached = await chrome.storage.local.get(this.cacheKey);
      const now = Date.now();

      if (cached[this.cacheKey] && 
          cached[this.cacheKey].data && 
          cached[this.cacheKey].timestamp &&
          (now - cached[this.cacheKey].timestamp) < this.cacheExpiry) {
        this.courseDB = cached[this.cacheKey].data;
        console.log('[MivaFocus Popup] Using cached DB');
        return;
      }

      console.log('[MivaFocus Popup] Fetching fresh DB...');
      this.showLoading();
      
      const response = await fetch(this.githubRawUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: Failed to fetch DB`);
      }
      
      this.courseDB = await response.json();

      if (!this.courseDB || !this.courseDB.departments) {
        throw new Error('Invalid database structure');
      }

      await chrome.storage.local.set({
        [this.cacheKey]: { 
          data: this.courseDB, 
          timestamp: now 
        }
      });
      console.log('[MivaFocus Popup] DB fetched and cached');
    } catch (error) {
      console.error('[MivaFocus Popup] DB load error:', error);
      this.showError('Failed to load course database. Please check your connection.');
      this.courseDB = null;
    }
  }

  populateDepartments() {
    const select = document.getElementById('department');
    if (!select) return;
    
    select.innerHTML = '<option value="">Select Department</option>';

    if (!this.courseDB || !this.courseDB.departments) {
      console.error('[MivaFocus Popup] No departments available');
      this.showError('Course database not loaded');
      return;
    }

    const deptEntries = Object.entries(this.courseDB.departments)
      .sort((a, b) => a[1].name.localeCompare(b[1].name));

    deptEntries.forEach(([code, data]) => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = `${data.name} (${code})`;
      select.appendChild(option);
    });
  }

  showError(message) {
    const errorEl = document.getElementById('error');
    const loadingEl = document.getElementById('loading');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.remove('hidden');
    }
    if (loadingEl) {
      loadingEl.classList.add('hidden');
    }
  }

  showLoading() {
    const loadingEl = document.getElementById('loading');
    const errorEl = document.getElementById('error');
    if (loadingEl) {
      loadingEl.classList.remove('hidden');
    }
    if (errorEl) {
      errorEl.classList.add('hidden');
    }
  }

  hideLoading() {
    const loadingEl = document.getElementById('loading');
    if (loadingEl) {
      loadingEl.classList.add('hidden');
    }
  }

  renderUI() {
    const onboarding = document.getElementById('onboarding');
    const settings = document.getElementById('settings');

    if (!onboarding || !settings) {
      console.error('[MivaFocus Popup] Required DOM elements not found');
      return;
    }

    // Show settings if department is already selected
    if (this.userSettings.department) {
      onboarding.classList.add('hidden');
      settings.classList.remove('hidden');

      this.updateToggleButton();
      this.displayCurrentSettings();
    } else {
      // Show onboarding for new users
      settings.classList.add('hidden');
      onboarding.classList.remove('hidden');

      this.populateDepartments();
      this.hideLoading();

      const deptSelect = document.getElementById('department');
      if (deptSelect && this.userSettings.department) {
        deptSelect.value = this.userSettings.department;
      }

      this.toggleSaveButton();
    }
  }

  displayCurrentSettings() {
    const currentSettingsEl = document.getElementById('currentSettings');
    if (!currentSettingsEl) return;

    const deptData = this.courseDB?.departments?.[this.userSettings.department];
    const deptName = deptData ? deptData.name : this.userSettings.department;

    currentSettingsEl.innerHTML = `
      <div style="background: #f1f5f9; padding: 1rem; border-radius: 6px; margin-bottom: 1rem;">
        <p style="margin: 0 0 0.5rem 0; color: #64748b; font-size: 0.875rem;">Current Department</p>
        <p style="margin: 0; font-weight: 600; color: #1e293b; font-size: 1.125rem;">
          ${deptName}
        </p>
      </div>
    `;
  }

  updateToggleButton() {
    const toggleBtn = document.getElementById('toggleGlobalFilter');
    if (toggleBtn) {
      const isEnabled = this.userSettings.filterEnabled;
      toggleBtn.textContent = isEnabled ? 'Disable Filter' : 'Enable Filter';
      toggleBtn.style.background = isEnabled ? '#ef4444' : '#3b82f6';
    }
  }

  attachListeners() {
    const deptSelect = document.getElementById('department');
    const saveBtn = document.getElementById('saveSetup');

    if (deptSelect) {
      deptSelect.addEventListener('change', () => this.toggleSaveButton());
    }
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.handleOnboarding());
    }

    const toggleBtn = document.getElementById('toggleGlobalFilter');
    const resetBtn = document.getElementById('resetSettings');

    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => this.toggleGlobalFilter());
    }
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this.resetSettings());
    }
  }

  toggleSaveButton() {
    const deptSelect = document.getElementById('department');
    const saveBtn = document.getElementById('saveSetup');
    
    if (deptSelect && saveBtn) {
      const dept = deptSelect.value;
      saveBtn.disabled = !dept;
    }
  }

  async handleOnboarding() {
    const deptSelect = document.getElementById('department');
    
    if (!deptSelect) return;

    const department = deptSelect.value;

    if (!department) {
      this.showError('Please select a department');
      return;
    }

    this.showLoading();

    try {
      // Save department only (no level required)
      this.userSettings.department = department;
      this.userSettings.onboardingComplete = true;
      this.userSettings.filterEnabled = false; // Start with filter disabled
      
      await this.saveSettings();

      // Store department courses for the content script
      if (this.courseDB?.departments?.[department]?.courses) {
        this.departmentCourses = {
          department: department,
          courses: this.courseDB.departments[department].courses
        };
        await chrome.storage.local.set({ departmentCourses: this.departmentCourses });
        console.log('[MivaFocus Popup] Courses stored for', department);
      } else {
        console.warn('[MivaFocus Popup] No courses found for department:', department);
      }

      // Notify any open LMS tabs
      await this.notifyLMSTabs('updateSettings', this.userSettings);

      this.hideLoading();
      this.renderUI();
    } catch (error) {
      console.error('[MivaFocus Popup] Onboarding error:', error);
      this.showError('Failed to save settings. Please try again.');
    }
  }

  async toggleGlobalFilter() {
    this.userSettings.filterEnabled = !this.userSettings.filterEnabled;
    await this.saveSettings();

    this.updateToggleButton();

    // Notify LMS tabs to update filter state
    await this.notifyLMSTabs('updateSettings', {
      filterEnabled: this.userSettings.filterEnabled
    });
  }

  async resetSettings() {
    if (!confirm('Reset all settings? This will clear your department selection and you will need to set it up again.')) {
      return;
    }

    try {
      this.userSettings = {};
      await chrome.storage.sync.clear();
      await chrome.storage.local.remove(['departmentCourses']);
      
      // Notify LMS tabs
      await this.notifyLMSTabs('resetSettings', {});
      
      this.renderUI();
    } catch (error) {
      console.error('[MivaFocus Popup] Reset error:', error);
      this.showError('Failed to reset settings');
    }
  }

  async notifyLMSTabs(action, data) {
    try {
      const tabs = await chrome.tabs.query({});
      const lmsTabs = tabs.filter(tab => 
        tab.url && 
        tab.url.includes(this.lmsDomain) &&
        tab.status === 'complete'
      );

      if (lmsTabs.length === 0) {
        return;
      }

      for (const tab of lmsTabs) {
        chrome.tabs.sendMessage(tab.id, { action, settings: data }, (response) => {
          if (!chrome.runtime.lastError) {
            console.log(`[MivaFocus Popup] Notified tab ${tab.id}`);
          }
        });
      }
    } catch (error) {
      // Silent fail - tabs may not be ready
    }
  }
}

new MivaFocusPopup();