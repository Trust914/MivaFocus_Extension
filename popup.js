class MivaFocusPopup {
  constructor() {
    this.userSettings = {};
    this.courseDB = null;
    this.cacheKey = "courseDBCache";
    this.cacheExpiry = 7 * 24 * 60 * 60 * 1000; // 7 days
    this.githubRawUrl =
      "https://raw.githubusercontent.com/trust914/MivaFocus_Scraper/master/courses_database.json";
    this.lmsDomain = "lms.miva.university";
    this.init();
  }

  async init() {
    await this.loadSettings();
    await this.loadAndCacheDB();
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

    if (
      cached[this.cacheKey] &&
      now - cached[this.cacheKey].timestamp < this.cacheExpiry
    ) {
      this.courseDB = cached[this.cacheKey].data;
      return;
    }

    try {
      this.showLoading();
      const response = await fetch(this.githubRawUrl);
      if (!response.ok) throw new Error("Failed to fetch database");
      this.courseDB = await response.json();
      await chrome.storage.local.set({
        [this.cacheKey]: { data: this.courseDB, timestamp: now },
      });
    } catch (err) {
      this.showError("Could not load departments. Check your internet.");
    } finally {
      this.hideLoading();
    }
  }

  populateDepartments() {
    const select = document.getElementById("department");
    if (!this.courseDB?.departments) return;

    select.innerHTML = '<option value="">Select Department</option>';
    const entries = Object.entries(this.courseDB.departments).sort((a, b) =>
      a[1].name.localeCompare(b[1].name)
    );

    for (const [code, data] of entries) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = `${data.name} (${code})`;
      select.appendChild(opt);
    }
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
    const name =
      this.courseDB?.departments?.[dept]?.name || "Unknown Department";

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

  async notifyLMSTabs(action, data) {
    const tabs = await chrome.tabs.query({});
    const lmsTabs = tabs.filter((t) => t.url?.includes(this.lmsDomain));
    for (const tab of lmsTabs)
      chrome.tabs.sendMessage(tab.id, { action, settings: data });
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
