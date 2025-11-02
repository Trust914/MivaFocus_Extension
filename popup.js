class MivaFocusPopup {
  constructor() {
    this.userSettings = {};
    this.courseDB = null;
    this.departmentMap = null; // lookup map
    this.cacheKey = "courseDBCache";
    this.cacheExpiry = 7 * 24 * 60 * 60 * 1000; // 7 days
    this.githubRawUrl =
      "https://raw.githubusercontent.com/trust914/MivaFocus_Scraper/master/miva_courses_full.json";
    // this.lmsDomain = "lms.miva.university";
    this.lmsDomain = "" // Accept all domains for local testing
    this.init();
  }

  async init() {
    await this.loadSettings();
    await this.loadAndCacheDB();
    this.buildDepartmentMap(); // Build lookup map once
    this.renderUI();
    this.attachListeners();
  }

  async loadSettings() {
    const result = await chrome.storage.sync.get("userSettings");
    this.userSettings = result.userSettings || {};
  }

  async saveSettings() {
    await chrome.storage.sync.set({ userSettings: this.userSettings });
  }

  async loadAndCacheDB() {
    const cached = await chrome.storage.local.get(this.cacheKey);
    const now = Date.now();

    if ( cached[this.cacheKey] && now - cached[this.cacheKey].timestamp < this.cacheExpiry) {
      this.courseDB = cached[this.cacheKey].data;
      return;
    }

    try {
      this.showLoading();
      const response = await fetch(this.githubRawUrl);
      if (!response.ok) throw new Error("Failed to fetch database");
      this.courseDB = await response.json();
      
      // Cache with compression consideration for large data
      await chrome.storage.local.set({
        [this.cacheKey]: { data: this.courseDB, timestamp: now },
      });
    } catch (err) {
      this.showError("Could not load departments. Check your internet.");
    } finally {
      this.hideLoading();
    }
  }


  buildDepartmentMap() {
    if (!this.courseDB?.faculties) return;
    
    this.departmentMap = new Map();
    
    for (const [facultyName, facultyData] of Object.entries(this.courseDB.faculties)) {
      if (!facultyData.departments) continue;
      
      for (const [deptCode, deptData] of Object.entries(facultyData.departments)) {
        this.departmentMap.set(deptCode, {
          ...deptData,
          faculty: facultyName
        });
      }
    }
  }

 
  populateDepartments() {
    const select = document.getElementById("department");
    if (!this.departmentMap || this.departmentMap.size === 0) return;

    // Use DocumentFragment for batch DOM insertion - much faster
    const fragment = document.createDocumentFragment();
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "Select Department";
    fragment.appendChild(defaultOpt);
    
    // Convert Map to array and sort once by faculty and name
    const sortedDepts = Array.from(this.departmentMap.entries())
      .sort((a, b) => {
        // Sort by faculty first, then by department name
        const facultyCompare = a[1].faculty.localeCompare(b[1].faculty);
        return facultyCompare !== 0 ? facultyCompare : a[1].name.localeCompare(b[1].name);
      });
    
    // Group by faculty and create optgroups
    let currentFaculty = null;
    let currentOptgroup = null;
    
    for (const [deptCode, deptData] of sortedDepts) {
      // Create new optgroup when faculty changes
      if (deptData.faculty !== currentFaculty) {
        if (currentOptgroup) {
          fragment.appendChild(currentOptgroup);
        }
        currentOptgroup = document.createElement("optgroup");
        currentOptgroup.label = deptData.faculty;
        currentFaculty = deptData.faculty;
      }
      
      const opt = document.createElement("option");
      opt.value = deptCode;
      opt.textContent = `${deptData.name} (${deptCode})`;
      currentOptgroup.appendChild(opt);
    }
    
    // Add the last optgroup
    if (currentOptgroup) {
      fragment.appendChild(currentOptgroup);
    }
    
    // Single DOM update - batch insert
    select.innerHTML = "";
    select.appendChild(fragment);
  }

  getDepartmentInfo(deptCode) {
    return this.departmentMap?.get(deptCode) || null;
  }

  renderUI() {
    const onboarding = document.getElementById("onboarding");
    const settings = document.getElementById("settings");

    if (this.userSettings.department) {
      onboarding.classList.add("hidden");
      settings.classList.remove("hidden");
      this.displayCurrentSettings();
      this.updateToggleButton();
    } else {
      onboarding.classList.remove("hidden");
      settings.classList.add("hidden");
      this.populateDepartments();
      this.hideLoading();
      this.toggleSaveButton();
    }
  }

  displayCurrentSettings() {
    const box = document.getElementById("currentSettings");
    const dept = this.userSettings.department;
    const deptInfo = this.getDepartmentInfo(dept);
    const name = deptInfo?.name || "Unknown Department";

    box.innerHTML = `
      <p style="opacity:0.8;">Current Department</p>
      <p style="font-size:1.05rem;font-weight:600;">${name}</p>
    `;
  }

  updateToggleButton() {
    const btn = document.getElementById("toggleGlobalFilter");
    const enabled = this.userSettings.filterEnabled;
    btn.textContent = enabled ? "Disable Filter" : "Enable Filter";
    btn.className = enabled ? "btn danger" : "btn secondary";
  }

  attachListeners() {
    const select = document.getElementById("department");
    const saveBtn = document.getElementById("saveSetup");
    const toggleBtn = document.getElementById("toggleGlobalFilter");
    const resetBtn = document.getElementById("resetSettings");

    if (select) select.addEventListener("change", () => this.toggleSaveButton());
    if (saveBtn) saveBtn.addEventListener("click", () => this.handleOnboarding());
    if (toggleBtn) toggleBtn.addEventListener("click", () => this.toggleGlobalFilter());
    if (resetBtn) resetBtn.addEventListener("click", () => this.resetSettings());
  }

  toggleSaveButton() {
    const select = document.getElementById("department");
    const saveBtn = document.getElementById("saveSetup");
    saveBtn.disabled = !select.value;
  }

  async handleOnboarding() {
    const dept = document.getElementById("department").value;
    if (!dept) return;

    this.userSettings = {
      department: dept,
      filterEnabled: false,
    };
    await this.saveSettings();
    this.renderUI();
  }

  async toggleGlobalFilter() {
    this.userSettings.filterEnabled = !this.userSettings.filterEnabled;
    await this.saveSettings();
    this.updateToggleButton();
    await this.notifyLMSTabs("updateSettings", this.userSettings);
  }

  async resetSettings() {
    await chrome.storage.sync.clear();
    await chrome.storage.local.remove(["departmentCourses"]);
    this.userSettings = {};
    this.renderUI();
  }

  // async notifyLMSTabs(action, data) {
  //   const tabs = await chrome.tabs.query({});
    
  //   // Filter and send in parallel - don't await each message
  //   const lmsTabs = tabs.filter((t) => t.url?.includes(this.lmsDomain));
    
  //   // Use Promise.allSettled to handle failures gracefully
  //   await Promise.allSettled(
  //     lmsTabs.map(tab => 
  //       chrome.tabs.sendMessage(tab.id, { action, settings: data })
  //         .catch(err => console.warn(`Failed to notify tab ${tab.id}:`, err))
  //     )
  //   );
  // }

  async notifyLMSTabs(action, data) {
    const tabs = await chrome.tabs.query({});
    
    // TEST MODE - notify ALL tabs (or filter by URL if needed)
    const relevantTabs = tabs.filter((t) => 
      t.url?.includes('lms.miva.university') || 
      t.url?.includes('localhost') ||
      t.url?.startsWith('file:///')
    );
    
    await Promise.allSettled(
      relevantTabs.map(tab => 
        chrome.tabs.sendMessage(tab.id, { action, settings: data })
          .catch(err => console.warn(`Failed to notify tab ${tab.id}:`, err))
      )
    );
}

  showLoading() {
    document.getElementById("loading").classList.remove("hidden");
    document.getElementById("error").classList.add("hidden");
  }

  hideLoading() {
    document.getElementById("loading").classList.add("hidden");
  }

  showError(msg) {
    const el = document.getElementById("error");
    el.textContent = msg;
    el.classList.remove("hidden");
  }
}

new MivaFocusPopup();